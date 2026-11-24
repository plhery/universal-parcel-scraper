import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DNIPRO_LOOKUP, DNIPRO_MAX_BYTES, dniproJson, dniproRefusal, isDniproBlocked, normalizeDniproNumber, parseDnipro, PROVIDER } from './parser.js';

export { DNIPRO_LOOKUP, normalizeDniproNumber, parseDnipro } from './parser.js';

const TRACKER_PAGE = 'https://dniprollc.com/en/packages-tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class DniproTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /**
   * The post the tracking page's script makes. No session, token or CAPTCHA: the page's browser
   * fingerprint is optional and left empty.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(DNIPRO_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://dniprollc.com', Referer: TRACKER_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ number, language: 'en', fingerprint: '' }) }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DNIPRO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    const json = JSON_TYPE.test(response.headers.get('content-type') ?? '');
    if (status === 401 || status === 403 || status === 503) {
      if (isDniproBlocked(body)) throw new ChallengeError(PROVIDER, 'Dnipro LLC answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'Dnipro LLC refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The lookup's own refusals: a JSON code such as the page's invalid_number.
    if (status === 400 && json) return dniproRefusal(dniproJson(body), status);
    // A redirect, or a 404 (WordPress's rest_no_route), is a moved lookup.
    if (status !== 200) throw new TransportError(PROVIDER, 'Dnipro LLC tracking is unavailable', { status });
    if (!json) {
      if (isDniproBlocked(body)) throw new ChallengeError(PROVIDER, 'Dnipro LLC answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'Dnipro LLC answered with a page instead of its tracking reply');
    }
    return parseDnipro(dniproJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDniproNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Dnipro LLC for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new DniproTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
