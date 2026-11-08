/**
 * What transport errors keep of a request and of the reply that refused it. Errors
 * reach step recorders and whatever serializes them, so no credential stays in an
 * enumerable field: credential header values, an address's user info, query values
 * and fragment, and a request body read `[redacted]`. A reply's body is kept for
 * adapters to read by name, but is not enumerable.
 */
import type { UpstreamHttpDiagnostics } from '../transport/upstreamHttpDiagnostics.js';
import type { UpstreamRequestDiagnostics } from './index.js';

const REDACTED = '[redacted]';

/** Authorization, cookies, and headers named after a key, token, secret, session or signature. */
const CREDENTIAL_HEADER = /^(?:proxy-)?authorization$|^(?:set-)?cookie2?$|^x-auth|token|secret|passw|key$|session|signature|csrf|xsrf/i;

// A caller's malformed details must not make the error itself throw.
function redactedHeaders(headers: Record<string, string>): Record<string, string> {
  return headers && typeof headers === 'object'
    ? Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, CREDENTIAL_HEADER.test(name) ? REDACTED : value]))
    : headers;
}

/** The address with its user info, query values and fragment redacted; parameter names stay. */
function redactedAddress(address: string): string {
  if (typeof address !== 'string') return address;
  const hash = address.indexOf('#');
  const beforeHash = hash < 0 ? address : address.slice(0, hash);
  const question = beforeHash.indexOf('?');
  const base = (question < 0 ? beforeHash : beforeHash.slice(0, question)).replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*@/i, `$1${REDACTED}@`);
  const query = question < 0 ? '' : `?${beforeHash.slice(question + 1).split('&').map((part) => {
    const equals = part.indexOf('=');
    return equals < 0 ? part && REDACTED : `${part.slice(0, equals)}=${REDACTED}`;
  }).join('&')}`;
  return base + query + (hash < 0 ? '' : `#${REDACTED}`);
}

export function redactedRequest(request: UpstreamRequestDiagnostics): UpstreamRequestDiagnostics {
  return {
    ...request, url: redactedAddress(request.url), headers: redactedHeaders(request.headers),
    ...(request.body === undefined ? {} : { body: REDACTED }),
  };
}

/** Defines `value` as a property that serializers skip and adapters still read by name. */
export function defineHidden(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
}

export function redactedReply(diagnostics: UpstreamHttpDiagnostics): UpstreamHttpDiagnostics {
  const { body_excerpt: excerpt, ...rest } = diagnostics;
  const copy: UpstreamHttpDiagnostics = {
    ...rest, headers: redactedHeaders(rest.headers), response_url: redactedAddress(rest.response_url),
  };
  if ('body_excerpt' in diagnostics) defineHidden(copy, 'body_excerpt', excerpt);
  return copy;
}
