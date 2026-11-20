import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, parseFormState, endpoint, portal, provider } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const guide = /^Z?[-\s]*(\d{4})[-\s]*(\d{8})$/i.exec(input.number.trim());
    if (!guide) throw new InvalidInputError(provider, 'Enter the SendBox guide with its four-digit Z and eight-digit serial');
    const [, prefix, serial] = guide;

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const userAgent = userAgentOf(environment.userAgent);
        const options = { provider, fetcher: environment.fetcher, maxBytes: 500_000, allowHttpStatuses: [403] };
        const page = await fetchBounded(portal, {
          headers: { Accept: 'text/html', 'User-Agent': userAgent }, signal,
        }, { ...options, timeoutMs: remainingMs });
        if (page.response.status === 403) throw new ChallengeError(provider, 'SendBox refused the guest form');
        const nonce = parseFormState(decodeText(page.bytes));
        const reply = await fetchBounded(endpoint, {
          method: 'POST',
          headers: { Accept: 'application/json', Origin: new URL(portal).origin, Referer: portal, 'User-Agent': userAgent },
          body: new URLSearchParams({
            action: 'seguimiento_bfg', nonce, vPrefijoGuia: prefix!, vNroGuia: serial!, vNroControl: '0',
          }),
          signal,
        }, { ...options, timeoutMs: Math.max(1, deadline - performance.now()) });
        if (reply.response.status === 403) throw new ChallengeError(provider, 'SendBox refused the guest guide lookup');
        return parseTracking(decodeText(reply.bytes));
      },
    }]);
  },
});
