# Pulls this checkout, then builds and installs Emdash Fork (Windows): `emdash-update`.
#   -Yes  quit a running Emdash Fork without asking
param([switch]$Yes)
$ErrorActionPreference = 'Stop'

# Inside Emdash's own terminal, the install would quit Emdash and this update with it:
# carry on in a console window of its own.
if ($env:TERM_PROGRAM -eq 'emdash' -and -not $env:EMDASH_UPDATE_HANDOFF) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command',
    "`$env:EMDASH_UPDATE_HANDOFF='1'; Remove-Item Env:TERM_PROGRAM; & '$PSCommandPath'$(if ($Yes) { ' -Yes' })")
  Start-Process -FilePath powershell -ArgumentList $arguments
  Write-Host 'Running inside Emdash, which the install quits: continuing in a new window.'
  exit 0
}

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
Set-Location $repoRoot

$changes = git status --porcelain
if ($changes) {
  Write-Host "The checkout at $repoRoot has uncommitted changes:"
  git status --short
  Write-Host 'Commit or stash them first.'
  exit 1
}

$branch = git rev-parse --abbrev-ref HEAD
Write-Host "==> Pulling $branch"
$before = git rev-parse HEAD
git pull --ff-only
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ((git remote) -contains 'upstream') {
  git fetch --quiet upstream main
  if ($LASTEXITCODE -ne 0) { Write-Host '(could not fetch upstream; build number may lag)' }
}
if ($before -eq (git rev-parse HEAD)) {
  Write-Host "Already at the latest commit ($(git rev-parse --short HEAD))."
} else {
  git log --oneline "$before..HEAD"
}

Write-Host '==> Installing dependencies'
& pnpm.cmd install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ((Get-Process -Name 'Emdash Fork' -ErrorAction SilentlyContinue) -and -not $Yes) {
  Write-Host ''
  Write-Host 'Emdash Fork is running. Installing quits it, which stops any agents running in it.'
  $answer = Read-Host 'Continue? [y/N]'
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host 'Stopped before building. Run emdash-update again when it is free.'
    exit 1
  }
}

Write-Host '==> Building and installing Emdash Fork'
$env:EMDASH_FORK_QUIT_CONFIRMED = '1'
& (Join-Path $PSScriptRoot 'install-local.ps1')
