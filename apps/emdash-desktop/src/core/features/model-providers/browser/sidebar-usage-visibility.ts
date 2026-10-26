import type { AgentUsage } from '@core/features/model-providers/api';

export const SIDEBAR_USAGE_AGENTS = ['claude', 'codex', 'cursor'] as const satisfies ReadonlyArray<
  AgentUsage['agent']
>;

export type SidebarUsageAgent = (typeof SIDEBAR_USAGE_AGENTS)[number];

export type SidebarUsageVisibility = {
  showLeftSidebarClaudeUsage?: boolean;
  showLeftSidebarCodexUsage?: boolean;
  showLeftSidebarCursorUsage?: boolean;
};

/** Missing settings stay visible, matching the interface defaults. */
export function sidebarUsageAgentVisible(
  agent: SidebarUsageAgent,
  settings: SidebarUsageVisibility | undefined
): boolean {
  switch (agent) {
    case 'claude':
      return settings?.showLeftSidebarClaudeUsage ?? true;
    case 'codex':
      return settings?.showLeftSidebarCodexUsage ?? true;
    case 'cursor':
      return settings?.showLeftSidebarCursorUsage ?? true;
  }
}
