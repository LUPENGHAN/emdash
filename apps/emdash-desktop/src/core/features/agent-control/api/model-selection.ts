/** Maps delegation selections to the same persisted fields as ordinary sessions. */
export function delegationModelSelection(selection: {
  model?: string;
  supplierId?: string;
  connection?: 'gateway' | 'official';
  effort?: string | null;
}): {
  model?: string;
  sourceModel?: string;
  supplierId?: string;
  modelSource?: string | null;
  effort?: string | null;
} {
  if (selection.supplierId && selection.connection === 'official')
    throw new Error('An API supplier requires gateway access, not official login.');
  if (selection.supplierId && !selection.model)
    throw new Error('Specify the supplier model when delegating this task.');
  return {
    ...(selection.model && { sourceModel: selection.model }),
    ...(selection.model &&
      selection.connection !== 'gateway' &&
      !selection.supplierId && { model: selection.model }),
    ...(selection.supplierId && { supplierId: selection.supplierId }),
    ...(selection.connection === 'gateway' || selection.supplierId
      ? { modelSource: 'gateway:models' }
      : selection.connection === 'official'
        ? { modelSource: null }
        : {}),
    ...(selection.effort !== undefined && { effort: selection.effort }),
  };
}
