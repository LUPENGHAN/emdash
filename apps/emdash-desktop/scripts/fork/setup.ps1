# One-time setup on Windows: adds `emdash-update` (this checkout's update.ps1) to your
# PATH, as setup.sh does on macOS. Run it again after moving the checkout.
#   -Uninstall  remove the command
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$bin = Join-Path $env:USERPROFILE '.local\bin'
$shim = Join-Path $bin 'emdash-update.cmd'

if ($Uninstall) {
  Remove-Item -Force $shim -ErrorAction SilentlyContinue
  Write-Host "Removed $shim"
  exit 0
}

# The build number counts this fork's commits past upstream's main.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
# (Listing remotes: Windows PowerShell stops at a native command's stderr, even redirected.)
if ((git -C $repoRoot remote) -notcontains 'upstream') {
  git -C $repoRoot remote add upstream https://github.com/generalaction/emdash.git
  git -C $repoRoot fetch --quiet upstream main
}

New-Item -ItemType Directory -Force $bin | Out-Null
$update = (Resolve-Path (Join-Path $PSScriptRoot 'update.ps1')).Path
# A .cmd shim runs anywhere (cmd, PowerShell, Emdash's terminals) whatever the
# execution policy, which blocks scripts by default.
Set-Content -Path $shim -Encoding ASCII -Value @(
  '@echo off',
  "powershell -NoProfile -ExecutionPolicy Bypass -File `"$update`" %*"
)

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -ieq $bin })) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$bin"), 'User')
  Write-Host "Added $bin to your PATH (open a new terminal to use it)."
}
Write-Host "Installed ${shim}: run emdash-update to pull, build and install Emdash Fork."
