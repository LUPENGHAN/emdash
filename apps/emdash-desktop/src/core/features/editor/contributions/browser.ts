import { languageServicesDialog } from '../browser/lsp/language-status';
import { conflictDialog } from '../browser/task-editor/conflict-dialog';
import { recoveredBufferDiffDialog } from '../browser/task-editor/recovered-buffer-diff-dialog';

export const editorBrowserContributions = {
  modalDefs: [conflictDialog, recoveredBufferDiffDialog, languageServicesDialog],
} as const;
