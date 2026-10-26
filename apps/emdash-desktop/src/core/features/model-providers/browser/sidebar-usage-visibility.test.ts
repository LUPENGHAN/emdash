import { describe, expect, it } from 'vitest';
import { sidebarUsageAgentVisible } from './sidebar-usage-visibility';

describe('sidebar usage visibility', () => {
  it('shows every subscription when the setting has not been stored', () => {
    expect(sidebarUsageAgentVisible('claude', undefined)).toBe(true);
    expect(sidebarUsageAgentVisible('codex', undefined)).toBe(true);
    expect(sidebarUsageAgentVisible('cursor', undefined)).toBe(true);
  });

  it('hides only the subscriptions turned off in settings', () => {
    const settings = {
      showLeftSidebarClaudeUsage: false,
      showLeftSidebarCodexUsage: true,
      showLeftSidebarCursorUsage: false,
    };
    expect(sidebarUsageAgentVisible('claude', settings)).toBe(false);
    expect(sidebarUsageAgentVisible('codex', settings)).toBe(true);
    expect(sidebarUsageAgentVisible('cursor', settings)).toBe(false);
  });
});
