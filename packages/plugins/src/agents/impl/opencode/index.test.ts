import { describe, expect, it } from 'vitest';
import { provider } from './index';

const baseContext = {
  cli: 'opencode',
  autoApprove: false,
  initialPrompt: undefined,
  sessionId: 'ses_emdash',
  providerSessionId: undefined,
  isResuming: false,
  model: '',
};

const standalone = { supportedFlags: ['--standalone'] };

describe('opencode provider', () => {
  it('keeps a terminal session off the shared background server when the CLI can', () => {
    expect(provider.behavior.prompt!.probeFlags).toEqual(['--standalone']);
    expect(
      provider.behavior.prompt!.buildCommand({ ...baseContext, ...standalone, initialPrompt: 'go' })
        .args
    ).toEqual(['--standalone', '--prompt', 'go']);
  });

  it('passes the flag when resuming and with user extra args', () => {
    const args = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      ...standalone,
      isResuming: true,
      providerSessionId: 'ses_native',
      extraArgs: ['--model', 'anthropic/claude'],
    }).args;

    expect(args).toEqual([
      '--session',
      'ses_native',
      '--model',
      'anthropic/claude',
      '--standalone',
    ]);
  });

  it('omits the flag on a CLI that does not list it', () => {
    expect(provider.behavior.prompt!.buildCommand(baseContext).args).not.toContain('--standalone');
    expect(
      provider.behavior.prompt!.buildCommand({
        ...baseContext,
        supportedFlags: ['--auto'],
        initialPrompt: 'go',
      }).args
    ).toEqual(['--prompt', 'go']);
  });

  it('keeps the flag once when user extra args already set it', () => {
    const args = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      ...standalone,
      extraArgs: ['--standalone'],
    }).args;

    expect(args).toEqual(['--standalone']);
  });

  it('still passes the auto-approve permission env', () => {
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      ...standalone,
      autoApprove: true,
    });

    expect(command.env).toEqual({ OPENCODE_PERMISSION: '{"*":"allow"}' });
  });
});
