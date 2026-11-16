import type { IncomingHttpHeaders } from 'node:http';

/** Preserve application fields while rebuilding each hop's transport and credentials. */
export function gatewayHttpHeaders(
  source: IncomingHttpHeaders,
  request: boolean
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  const excluded = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);
  for (const [name, value] of Object.entries(source)) {
    if (name.toLowerCase() === 'connection') {
      for (const token of (Array.isArray(value) ? value.join(',') : (value ?? '')).split(',')) {
        excluded.add(token.trim().toLowerCase());
      }
    }
  }
  const blocked = (name: string) =>
    excluded.has(name) ||
    name.startsWith('x-emdash-') ||
    (request
      ? [
          'authorization',
          'x-api-key',
          'cookie',
          'forwarded',
          'x-forwarded-for',
          'x-forwarded-host',
          'x-forwarded-proto',
        ].includes(name)
      : name === 'set-cookie');
  for (const [name, value] of Object.entries(source)) {
    const key = name.toLowerCase();
    if (!blocked(key)) headers[key] = value;
  }
  // Trailer is hop-specific, but allowed application trailers need a new declaration.
  const trailers = source.trailer
    ?.split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name && !blocked(name));
  if (trailers?.length) headers.trailer = trailers.join(', ');
  return headers;
}
