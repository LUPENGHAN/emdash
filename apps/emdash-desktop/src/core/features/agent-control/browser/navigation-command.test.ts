import { beforeEach, describe, expect, it, vi } from 'vitest';

const getActiveCommand = vi.hoisted(() => vi.fn());

vi.mock('@core/primitives/view-scopes/browser', () => ({
  scopes: { getActiveCommand },
}));

import { listNavigationCommands, runNavigationCommand } from './navigation-command';

const execute = vi.fn();

function bind(kind: 'enabled' | 'disabled' | 'hidden') {
  return {
    availability: kind === 'disabled' ? { kind, reason: 'Unavailable' } : { kind },
    presentation: undefined,
    execute,
  };
}

describe('navigation commands', () => {
  beforeEach(() => {
    getActiveCommand.mockReset();
    execute.mockReset();
  });

  it('lists task.sidebarFiles as enabled with its catalog title and does not run it', () => {
    getActiveCommand.mockImplementation((command: { id: string }) =>
      command.id === 'task.sidebarFiles' ? bind('enabled') : undefined
    );

    expect(listNavigationCommands().split('\n')).toContain(
      'task.sidebarFiles, enabled, View Files'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(getActiveCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task.sidebarFiles' }),
      {
        belowActiveCapture: true,
      }
    );
  });

  it('runs an enabled command once through the palette binding', () => {
    getActiveCommand.mockImplementation((command: { id: string }) =>
      command.id === 'task.sidebarFiles' ? bind('enabled') : undefined
    );

    expect(runNavigationCommand('task.sidebarFiles')).toBe('Ran View Files.');
    expect(runNavigationCommand('task.sidebarFiles')).toBe('Ran View Files.');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(undefined, 'palette');
    expect(getActiveCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task.sidebarFiles' }),
      {
        belowActiveCapture: true,
      }
    );
  });

  it('refuses a hidden or disabled command without running it', () => {
    getActiveCommand.mockReturnValue(undefined);
    expect(() => runNavigationCommand('task.sidebarFiles')).toThrow(/not available/);
    expect(listNavigationCommands()).toContain('task.sidebarFiles, hidden, View Files');

    getActiveCommand.mockReturnValue(bind('disabled'));
    expect(() => runNavigationCommand('task.sidebarFiles')).toThrow(/not available/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not look up commands outside the allowlist', () => {
    expect(() => runNavigationCommand('task.gitPush')).toThrow(/not available/);
    expect(() => runNavigationCommand('task.deleteSelected')).toThrow(/not available/);
    expect(() => runNavigationCommand('app.voiceInput')).toThrow(/not available/);
    expect(getActiveCommand).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
