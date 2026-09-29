import type { SessionSummary } from '@emdash/core/runtimes/acp/api';
import { HANDOFF_PROMPT_OPENER } from '@core/primitives/conversations/api';

export type AcpSessionTitleAction = { conversationId: string; title: string };

export function deriveAcpSessionTitleAction(
  previous: SessionSummary | undefined,
  next: SessionSummary
): AcpSessionTitleAction | null {
  if (!next.title) return null;
  if (previous?.title === next.title) return null;
  // A handed-off conversation keeps its title, not the handoff message the agent named it by.
  if (next.title.startsWith(HANDOFF_PROMPT_OPENER)) return null;
  return { conversationId: next.conversationId, title: next.title };
}
