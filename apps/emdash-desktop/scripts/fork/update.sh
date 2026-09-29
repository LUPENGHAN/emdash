#!/usr/bin/env bash
# Updates the fork in one go: pulls the branch, installs dependencies, then builds,
# signs and installs Emdash Fork (install-local.sh). Linked as `edhash-update` in
# ~/.local/bin. `-y` skips the question asked when Emdash Fork is running.
set -euo pipefail

# The whole body is one function, read in full before it runs, so the pull below can
# change this file safely.
main() {
  local assume_yes=0
  case "${1:-}" in
    -y | --yes) assume_yes=1 ;;
    -h | --help)
      echo "Usage: edhash-update [-y]  pull, build and install Emdash Fork"
      return 0
      ;;
    '') ;;
    *)
      echo "Unknown option: $1" >&2
      return 2
      ;;
  esac

  local script repo_root
  script="$(readlink -f "${BASH_SOURCE[0]}")"
  repo_root="$(cd "$(dirname "$script")/../../../.." && pwd)"
  cd "$repo_root"

  if [ -n "$(git status --porcelain)" ]; then
    echo "The checkout at $repo_root has uncommitted changes:" >&2
    git status --short >&2
    echo "Commit or stash them first." >&2
    return 1
  fi

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  echo "==> Pulling $branch"
  local before
  before="$(git rev-parse HEAD)"
  git pull --ff-only
  # The official release the fork's build number counts from.
  if git remote get-url upstream >/dev/null 2>&1; then
    git fetch --quiet upstream main || echo "(could not fetch upstream; build number may lag)"
  fi
  if [ "$before" = "$(git rev-parse HEAD)" ]; then
    echo "Already at the latest commit ($(git rev-parse --short HEAD))."
  else
    git log --oneline "$before..HEAD"
  fi

  echo "==> Installing dependencies"
  pnpm install --frozen-lockfile

  if pgrep -x "Emdash Fork" >/dev/null && [ "$assume_yes" -eq 0 ]; then
    echo
    echo "Emdash Fork is running. Installing quits it, which stops any agents running in it."
    local answer
    read -r -p "Continue? [y/N] " answer
    case "$answer" in
      y | Y | yes) ;;
      *)
        echo "Stopped before building. Run edhash-update again when it is free."
        return 1
        ;;
    esac
  fi

  echo "==> Building and installing Emdash Fork"
  bash "$repo_root/apps/emdash-desktop/scripts/fork/install-local.sh"
}

main "$@"
