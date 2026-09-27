import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-conversation MCP URLs: `/mcp/<conversationId>/<signature>`. The signature is an
 * HMAC with a persisted secret, so a running agent's URL keeps working across app
 * restarts and cannot be forged for another conversation.
 */
export function signConversation(secret: Buffer, conversationId: string): string {
  return createHmac('sha256', secret).update(`agent-control:${conversationId}`).digest('base64url');
}

export function mcpPath(secret: Buffer, conversationId: string): string {
  return `/mcp/${encodeURIComponent(conversationId)}/${signConversation(secret, conversationId)}`;
}

/** The conversation id a request path was signed for, or null. */
export function verifyMcpPath(secret: Buffer, pathname: string): string | null {
  const match = /^\/mcp\/([^/]+)\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (!match) return null;
  const conversationId = decodeURIComponent(match[1]!);
  const expected = Buffer.from(signConversation(secret, conversationId));
  const given = Buffer.from(match[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? conversationId
    : null;
}
