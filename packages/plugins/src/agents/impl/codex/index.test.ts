import { describe, expect, it } from 'vitest';
import { provider } from './index';

const baseContext = {
  cli: 'codex',
  autoApprove: false,
  initialPrompt: undefined,
  sessionId: 'emdash-session-id',
  providerSessionId: undefined,
  isResuming: false,
  model: '',
};

describe('codex provider', () => {
  it('passes unquoted config overrides when auto-approve is enabled', () => {
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      autoApprove: true,
    });

    expect(command).toEqual({
      command: 'codex',
      args: [
        '-c',
        'approval_policy=never',
        '-c',
        'sandbox_mode=danger-full-access',
        '--dangerously-bypass-hook-trust',
        '-c',
        'features.tui_workspace=false',
        '-c',
        expect.stringContaining('developer_instructions='),
      ],
      env: {},
    });
  });

  it('keeps the session out of the shared background server when the CLI can', () => {
    const noDaemon = { supportedFlags: ['--no-daemon'] };
    const resume = {
      ...baseContext,
      isResuming: true,
      providerSessionId: 'thread-1',
      extraArgs: ['-c', 'model_provider=x'],
    };
    expect(provider.behavior.prompt!.probeFlags).toEqual(['--no-daemon']);
    expect(provider.behavior.prompt!.buildCommand({ ...resume, ...noDaemon }).args).toEqual([
      'resume',
      'thread-1',
      '-c',
      'model_provider=x',
      '-c',
      'features.tui_workspace=false',
      '-c',
      expect.stringContaining('developer_instructions='),
      '--no-daemon',
    ]);
    expect(
      provider.behavior.prompt!.buildCommand({ ...baseContext, ...noDaemon, initialPrompt: 'go' })
        .args
    ).toEqual([
      '-c',
      'features.tui_workspace=false',
      '-c',
      expect.stringContaining('developer_instructions='),
      '--no-daemon',
      'go',
    ]);
    // An older Codex rejects the flag, so it is only passed when the CLI lists it.
    expect(provider.behavior.prompt!.buildCommand(resume).args).not.toContain('--no-daemon');
  });
});
