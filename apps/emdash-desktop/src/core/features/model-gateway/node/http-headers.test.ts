import { describe, expect, it } from 'vitest';
import { gatewayHttpHeaders } from './http-headers';

describe('gateway HTTP headers', () => {
  it('keeps application headers and removes credentials and Connection-nominated fields', () => {
    expect(
      gatewayHttpHeaders(
        {
          connection: 'keep-alive, X-Hop, session_id',
          'x-hop': 'hop-only',
          session_id: 'untrusted-session',
          authorization: 'local-token',
          'x-api-key': 'local-token',
          cookie: 'local-cookie',
          'x-emdash-account': 'untrusted-account',
          'proxy-authorization': 'local-proxy-token',
          'x-forwarded-for': 'untrusted-ip',
          'openai-project': 'project',
          'x-feature': ['one', 'two'],
          'accept-encoding': 'gzip',
          trailer: 'X-Checksum, Authorization, X-Emdash-Account, X-Hop',
        },
        true
      )
    ).toEqual({
      'openai-project': 'project',
      'x-feature': ['one', 'two'],
      'accept-encoding': 'gzip',
      trailer: 'x-checksum',
    });
  });

  it('retains rate limits, repeated response fields and safe trailers without local cookies', () => {
    expect(
      gatewayHttpHeaders(
        {
          connection: 'X-Hop',
          'x-hop': 'hop-only',
          'set-cookie': ['provider-login=secret'],
          'retry-after': '15',
          'x-ratelimit-remaining': '3',
          'x-feature': ['one', 'two'],
          trailer: 'X-Checksum, Set-Cookie',
        },
        false
      )
    ).toEqual({
      'retry-after': '15',
      'x-ratelimit-remaining': '3',
      'x-feature': ['one', 'two'],
      trailer: 'x-checksum',
    });
  });
});
