/** Recognizes the reserved management namespace in branch names and qualified refs. */
export function isManagementBranch(ref: string): boolean {
  return ref.replace(/^refs\/(?:heads\/|remotes\/[^/]+\/)/, '').startsWith('emdash/manage/');
}
