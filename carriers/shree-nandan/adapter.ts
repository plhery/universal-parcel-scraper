import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, parseWithheld, provider, PURPOSES, type Part, type Replies } from './parser.js';

/** The lookup the carrier's Connecting Nandan `/web-tracking/` page makes, once per part of its answer. */
const endpoint = 'https://api.connectingnandan.com/v1/utilities/tracking/web-view/';
// The page's own key, the same for every visitor.
const API_KEY = 'NANDAN_OPERATION_WEB_2022'; // gitleaks:allow
const CHALLENGE = /<html|cf-chl|cf-turnstile|captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

export const adapter: AdapterFactory = (environment) => {
  async function part(number: string, which: Part, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(endpoint + number, {
      method: 'POST', signal,
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(environment.userAgent),
        platform: 'WEB', 'api-key': API_KEY, 'app-id': '1',
        Origin: 'https://connectingnandan.com', Referer: `https://connectingnandan.com/web-tracking/${number}`,
      },
      body: JSON.stringify({ con_no: number, purpose: PURPOSES[which], is_external_tracking: 1 }),
    }, { provider, fetcher: environment.fetcher, timeoutMs, maxBytes: 500_000, allowHttpStatuses: [403, 423] });
    const body = decodeText(bytes);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (cause) {
      if (response.status === 403 || CHALLENGE.test(body.slice(0, 16_000))) {
        throw new ChallengeError(provider, 'Shree Nandan Courier answered with a browser check', { cause, status: response.status });
      }
      throw new SchemaError(provider, 'Shree Nandan Courier returned a reply that is not JSON', { cause });
    }
    if (response.status === 403) throw new ChallengeError(provider, 'Shree Nandan Courier refused the lookup', { status: 403, reason: 'api_denied' });
    if (response.status === 423) parseWithheld(payload);
    return payload;
  }

  async function read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page asks for the travel rows, the booking and the delivery records at once.
    // A part that fails ends the other two, so no request outlives the read.
    const sibling = new AbortController();
    const both = AbortSignal.any([signal, sibling.signal]);
    try {
      const [travel, booking, delivery] = await Promise.all((['travel', 'booking', 'delivery'] as const)
        .map((which) => part(number, which, both, timeoutMs)));
      const replies: Replies = { travel, booking, delivery };
      return parseTracking(replies, number);
    } finally {
      sibling.abort();
    }
  }

  return {
    id: provider, steps: ['direct', 'retry'], recordsSteps: true,
    async track(input, context = {}) {
      const number = input.number.replace(/[\s-]+/g, '');
      if (!/^(?:\d{11}|\d{13})$/.test(number)) {
        throw new InvalidInputError(provider, 'Enter a Shree Nandan Courier shipment number of eleven or thirteen digits');
      }
      // A read that fails to reach the carrier, or hangs, is sent once more: the first try gets half of the budget.
      return runSteps({
        carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
      }, [
        { id: 'direct', run: ({ signal, remainingMs }) => read(number, signal, firstAttemptMs(remainingMs)) },
        networkRetryStep(({ signal, remainingMs }) => read(number, signal, remainingMs)),
      ]);
    },
  };
};
