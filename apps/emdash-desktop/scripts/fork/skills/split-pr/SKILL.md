---
name: split-pr
description: Split a finished feature branch into a series of small, reviewable pull requests (about 500-800 changed lines each), each built in its own git worktree created through Emdash. Use when the user asks to split, break up, or slice a branch, feature, or large diff into smaller or stacked PRs, or to extract part of a change into its own PR.
---

# Split a feature into small PRs

The feature branch stays the source of truth: every slice copies changes out of it
and it is never rewritten. Each slice gets its own branch and worktree, created with
the Emdash `create_task` tool, so the user can open and review every slice in Emdash.

## 1. Pin down the source

- Work from the feature branch's latest commit. If it has uncommitted changes, ask
  the user to commit them first (or commit them yourself if they say so): slices are
  copied from commits, so uncommitted work would be left out.
- Record: `FEATURE` (the branch), `BASE` (the branch it will merge into, usually the
  default branch), and `git merge-base BASE FEATURE`.
- Size of the whole change: `git diff --shortstat <merge-base> FEATURE` and
  `git diff --numstat <merge-base> FEATURE`.

## 2. Plan the slices, and get the user's OK

- Target 500-800 changed lines (added + removed) per slice, unless the user gives
  another size. Lockfiles and generated files do not count toward the size, but go
  in the slice that needs them.
- Each slice must build and pass tests on its own, on top of the slices before it.
  Order by dependency: shared types, schemas and migrations first; then core logic;
  then UI and wiring; then cleanup. Tests travel with the code they test.
- Keep a file whole when possible. Split a file across slices only when it alone is
  over the limit or mixes unrelated changes, and say so in the plan.
- Stacked or independent: a slice that needs an earlier one starts from that slice's
  branch (a stack); a slice that stands alone starts from `BASE`.
- Show the plan as a table: slice number, short name, files, approximate lines, the
  branch it starts from. Wait for the user to approve or adjust it before creating
  anything.

## 3. Build each slice, in order

For slice N:

1. Create its worktree with the Emdash MCP tool `create_task`: `name`
   `<feature>-part-N-<topic>`, `base_branch` = `BASE` or the previous slice's branch.
   Do not use `git worktree add` or any worktree feature of your own. The tool
   returns the worktree path (call it `WT`) and the branch.
2. Bring over the slice's changes from the feature branch (all branches are shared
   by every worktree of the repository):
   - whole files: `git -C WT checkout FEATURE -- <paths>`; deleted files:
     `git -C WT rm <paths>`.
   - part of a file: take `git diff <merge-base> FEATURE -- <path>` and apply only
     the hunks this slice needs (`git -C WT apply` with an edited patch, or write the
     intermediate version of the file by hand). The file's final state arrives in a
     later slice.
3. Make the slice stand on its own: run the project's typecheck, lint and the tests
   for the touched area in `WT`. Add only what is strictly needed to compile (e.g. a
   stub the next slice replaces) and mention it in the PR description.
4. Check the size: `git -C WT diff --shortstat <slice's start branch>`. If it is well
   over the target, move files to a later slice rather than shipping it big.
5. Commit in `WT` with a Conventional Commits message for that slice.

## 4. Verify nothing was lost

- Stacked series: `git diff <last slice branch> FEATURE` must be empty (or contain
  only what the user agreed to leave out).
- Independent slices: every file in `git diff --name-only <merge-base> FEATURE` must be
  in exactly one slice, and each file's final content must match `FEATURE`.
- Report any difference to the user before going on.

## 5. Open the PRs (ask first)

Pushing and opening PRs are visible to others: list the branches and their bases and
ask before doing it. Then, per slice in order: push its branch and open a PR against
its start branch (`gh pr create --base <start branch>`), titled with the slice's
commit summary and described with "Part N of M" of the feature, what it contains, what
it depends on, and what later parts add. Do not force-push or rewrite the feature
branch or earlier slices without asking.

## Notes

- If a later slice needs a change to an earlier one (review feedback, a missed
  hunk), change the earlier slice's worktree, commit there, and merge or rebase the
  later slices onto it; say which.
- Slices can be done by other agents: `create_task` takes a `prompt` (and `agent`) to
  start an agent in the new worktree with the slice's instructions. Keep the
  verification step (4) with whoever owns the whole series.
