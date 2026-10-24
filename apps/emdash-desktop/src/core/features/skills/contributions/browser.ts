import { createSkillModal } from '../browser/components/CreateSkillModal';
import { importGitHubSkillModal } from '../browser/components/ImportGitHubSkillModal';
import { importLocalSkillModal } from '../browser/components/ImportLocalSkillModal';
import { skillDetailModal } from '../browser/components/SkillDetailModal';

export const skillsBrowserContributions = {
  modalDefs: [createSkillModal, importGitHubSkillModal, importLocalSkillModal, skillDetailModal],
} as const;
