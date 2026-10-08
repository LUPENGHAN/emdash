# Builds Emdash Fork from this checkout and installs it for this user on Windows, the
# counterpart of install-local.sh. A running Emdash Fork is quit first; set
# EMDASH_FORK_QUIT_CONFIRMED=1 once the user agreed to stop what runs in it.
#   -NoLaunch  install without starting it afterwards
param([switch]$NoLaunch)
$ErrorActionPreference = 'Stop'

$appDir = (Resolve-Path "$PSScriptRoot\..\..").Path
$repoRoot = (Resolve-Path "$appDir\..\..").Path
# The .cmd shims: PowerShell's .ps1 ones are blocked by the default execution policy.
$pnpm = 'pnpm.cmd'

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command $($Arguments -join ' ') failed ($LASTEXITCODE)" }
}

Set-Location $repoRoot
Invoke-Checked $pnpm @('run', 'build') | Out-Null # workspace packages

Set-Location $appDir
$upstream = git rev-parse --verify --quiet upstream/main 2>$null
$range = if ($upstream) { "$upstream..HEAD" } else { 'HEAD' }
$forkCommits = git rev-list --count $range
$dirty = if (git status --porcelain) { '+dirty' } else { '' }
$forkVersion = "fork.$forkCommits ($(git rev-parse --short=7 HEAD)$dirty)"
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
Write-Host "Building Emdash Fork $version - $forkVersion (x64)"

$env:VITE_BUILD = 'fork'
$env:VITE_FORK_VERSION = $forkVersion
Invoke-Checked $pnpm @('exec', 'electron-vite', 'build') | Out-Null
$release = Join-Path $appDir 'release'
if (Test-Path $release) { Remove-Item -Recurse -Force $release }
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
# electron-builder lists dependencies through `pnpm` in a PowerShell of its own, which the
# default execution policy stops at pnpm's .ps1 shim: allow scripts for this build only.
$env:PSExecutionPolicyPreference = 'Bypass'
# Run directly, not through `pnpm exec`: inside it, that dependency listing fails
# ("The system cannot find the path specified"). Outside it, electron-builder would take
# the project for an npm one and package the app's own dependencies only nested in the
# workspace packages, where its code does not find them: say it is pnpm's.
$env:npm_config_user_agent = 'pnpm/10.28.2'
$builder = Join-Path $repoRoot 'node_modules\.bin\electron-builder.CMD'
# Windows Defender scanning the freshly unpacked Electron can refuse its rename (EPERM):
# a later attempt goes through.
for ($attempt = 1; ; $attempt++) {
  & $builder --win nsis --x64 --publish never --config electron-builder.fork.config.ts
  if ($LASTEXITCODE -eq 0) { break }
  if ($attempt -ge 3) { throw "electron-builder failed ($LASTEXITCODE)" }
  Write-Host "Packaging failed; trying again ($($attempt + 1) of 3)"
  Remove-Item -Recurse -Force $release -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
}
$installer = Get-ChildItem $release -Filter 'emdash-fork-*.exe' | Select-Object -First 1
if (-not $installer) { throw "No installer was built in $release" }

# Quit a running Emdash Fork: the marker tells it the user agreed, so it skips asking.
$running = @(Get-Process -Name 'Emdash Fork' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  $profileDir = Join-Path $env:APPDATA 'emdash-fork'
  $marker = Join-Path $profileDir 'quit-for-install'
  if ($env:EMDASH_FORK_QUIT_CONFIRMED -eq '1') {
    New-Item -ItemType Directory -Force $profileDir | Out-Null
    Set-Content -Path $marker -Value ''
  }
  foreach ($process in $running) { [void]$process.CloseMainWindow() }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Process -Name 'Emdash Fork' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
  }
  # Still there (kept in the tray, or stuck): stop it.
  Get-Process -Name 'Emdash Fork' -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-Item -Force $marker -ErrorAction SilentlyContinue
}

Write-Host 'Installing'
$install = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "The installer failed ($($install.ExitCode))" }

# The fork's own skills, linked into the shared skill library every agent reads.
$library = Join-Path $env:USERPROFILE '.agentskills'
New-Item -ItemType Directory -Force $library | Out-Null
foreach ($skill in Get-ChildItem (Join-Path $appDir 'scripts\fork\skills') -Directory) {
  $target = Join-Path $library $skill.Name
  $existing = Get-Item $target -ErrorAction SilentlyContinue
  if ($existing -and -not ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Write-Host "Kept your own skill $target (the fork's $($skill.Name) was not installed)"
    continue
  }
  if ($existing) { $existing.Delete() }
  New-Item -ItemType Junction -Path $target -Target $skill.FullName | Out-Null
}

Remove-Item -Recurse -Force $release
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Emdash Fork\Emdash Fork.exe'
if (-not $NoLaunch) { Start-Process -FilePath $exe }
Write-Host "Installed $exe"
