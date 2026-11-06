import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';

export const ALLEGRO_TRACKING_MAX_BYTES = 256 * 1024;
const MEDIA_TYPE = 'application/vnd.allegro.internal.v1+json';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /captcha-delivery\.com|datadome/i;

/** Read-only guest protocol shared by the distinct national Allegro gateways. */
export async function fetchAllegroTracking(url: string, options: {
  provider: string; signal: AbortSignal; timeoutMs: number; language: string;
  fetcher?: typeof fetch; userAgent?: string; strictRoute?: boolean; challengePattern?: RegExp;
}): Promise<unknown> {
  const { response, bytes } = await fetchBounded(url, { signal: options.signal, headers: {
    Accept: MEDIA_TYPE, 'Accept-Language': options.language, 'User-Agent': userAgentOf(options.userAgent),
  } }, { provider: options.provider, timeoutMs: Math.max(1, Math.floor(options.timeoutMs)),
    maxBytes: ALLEGRO_TRACKING_MAX_BYTES, redirect: 'manual',
    allowHttpStatuses: [...REDIRECTS, 400, 404, 406, 410], fetcher: options.fetcher });
  // A refused or moved service says nothing about the shipment.
  if (response.status !== 200) throw new IndeterminateError(options.provider, options.provider + ' tracking service is unavailable');
  if (options.strictRoute && (response.redirected || (response.url && response.url !== url))) {
    throw new SchemaError(options.provider, 'The guest tracker changed the number-bound lookup route');
  }
  const text = decodeText(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (CHALLENGE.test(text) || options.challengePattern?.test(text)) {
      throw new ChallengeError(options.provider, options.provider + ' answered with a bot check', { cause: error });
    }
    throw new SchemaError(options.provider, options.provider + ' returned a reply that is not JSON', { cause: error });
  }
}
