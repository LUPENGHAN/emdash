/**
 * The option a conversation's auto-approval picks for a permission request: allow this
 * once, so turning auto-approval off stops it (an "always" answer becomes the agent's own
 * standing rule); "always" only where the agent offers nothing else. Null when it offers
 * no way to allow.
 */
export function autoApproveOption(
  options: readonly { optionId: string; kind: string }[]
): string | null {
  return (
    (
      options.find((option) => option.kind === 'allow_once') ??
      options.find((option) => option.kind === 'allow_always')
    )?.optionId ?? null
  );
}
