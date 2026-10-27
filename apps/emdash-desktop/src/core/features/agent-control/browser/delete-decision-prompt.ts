/** Copy for the confirm dialog before an agent deletes a decision. */
export function deleteDecisionPrompt(
  who: string,
  title: string
): { title: string; description: string; confirmLabel: string } {
  return {
    title: `${who} wants to delete “${title}”`,
    description: 'This cannot be undone.',
    confirmLabel: 'Delete',
  };
}
