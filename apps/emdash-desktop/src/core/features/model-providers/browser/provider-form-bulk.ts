import { parseContextWindow, type ClaudeModelRoles } from '../api';

/** Blank clears the selected models. Any other text must parse as a context window. */
export function canApplyContextToSelected(selectedCount: number, text: string): boolean {
  if (selectedCount === 0) return false;
  const trimmed = text.trim();
  return trimmed === '' || parseContextWindow(trimmed) !== null;
}

/** Writes `text` onto every selected model. Models outside `selected` stay as they are. */
export function applyContextWindowToSelected(
  contexts: Record<string, string>,
  selected: readonly string[],
  text: string
): Record<string, string> {
  const next = { ...contexts };
  for (const model of selected) next[model] = text;
  return next;
}

/** Points every Claude Code role at `model` and keeps display names already typed. */
export function claudeRolesForEveryRole(roles: ClaudeModelRoles, model: string): ClaudeModelRoles {
  return {
    ...roles,
    model,
    opus: model,
    sonnet: model,
    haiku: model,
    fable: model,
    subagent: model,
  };
}
