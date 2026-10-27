/** Copy for the confirm dialog before an agent deletes a requirement. */
export function deleteRequirementPrompt(
  who: string,
  title: string,
  childCount: number
): { title: string; description: string; confirmLabel: string } {
  const description =
    childCount > 0
      ? `This also deletes its ${childCount} sub-requirement${childCount === 1 ? '' : 's'}. This cannot be undone.`
      : 'This cannot be undone.';
  return {
    title: `${who} wants to delete “${title}”`,
    description,
    confirmLabel: 'Delete',
  };
}
