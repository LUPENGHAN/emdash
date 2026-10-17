import { createSkillModal } from '../browser/components/CreateSkillModal';
import { importGitHubSkillModal } from '../browser/components/ImportGitHubSkillModal';
import { skillDetailModal } from '../browser/components/SkillDetailModal';

export const skillsBrowserContributions = {
  modalDefs: [createSkillModal, importGitHubSkillModal, skillDetailModal],
} as const;
