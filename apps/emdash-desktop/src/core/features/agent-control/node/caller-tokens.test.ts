import { describe, expect, it } from 'vitest';
import { mcpPath, verifyMcpPath } from './caller-tokens';

describe('caller tokens', () => {
  const secret = Buffer.from('s');
  it('round-trips and rejects another conversation’s signature', () => {
    expect(verifyMcpPath(secret, mcpPath(secret, 'conv-1'))).toBe('conv-1');
    const other = mcpPath(secret, 'conv-2').split('/').at(-1);
    expect(verifyMcpPath(secret, `/mcp/conv-1/${other}`)).toBeNull();
    expect(verifyMcpPath(Buffer.from('x'), mcpPath(secret, 'conv-1'))).toBeNull();
  });
});
