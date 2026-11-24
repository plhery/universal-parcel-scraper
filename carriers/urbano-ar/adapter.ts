import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  hasGuide, isUrbanoBlocked, normalizeUrbanoNumber, parseUrbanoDetail, parseUrbanoLookup, PROVIDER, URBANO_DETAIL, URBANO_MAX_BYTES,
  urbanoLookupUrl, urbanoResult, type UrbanoNumber,
} from './parser.js';

export { normalizeUrbanoNumber, parseUrbanoDetail, parseUrbanoLookup, urbanoLookupUrl, urbanoResult } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the page answers an unknown code with "Sin información".
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export class UrbanoArTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async page(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { ...init, signal, headers: {
      Accept: 'text/html,application/xhtml+xml,*/*', 'User-Agent': userAgentOf(this.options.userAgent), ...init.headers,
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: URBANO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 401, 403, 429, 503],
    });
    const { status } = response;
    const html = decodeText(bytes);
    if (status === 401 || status === 403) throw new ChallengeError(PROVIDER, 'Urbano refused the lookup', { status });
    if (status === 429) throw new ChallengeError(PROVIDER, 'Urbano throttled the lookup', { status });
    if (status === 503) {
      if (isUrbanoBlocked(html)) throw new ChallengeError(PROVIDER, 'Urbano answered with a block page', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    if (REDIRECTS.includes(status)) throw new TransportError(PROVIDER, 'Urbano redirected its tracking page', { status });
    if (GONE.includes(status)) throw new TransportError(PROVIDER, 'Urbano tracking is unavailable', { status });
    if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Urbano returned an empty page');
    return html;
  }

  /**
   * The page the tracking form opens, then, for each of its rows with a guide, the post its
   * magnifier makes with the row's data to list the scans. No session, token or CAPTCHA: the
   * form's reCAPTCHA only gates the button.
   */
  private async read(asked: UrbanoNumber, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    const lookup = await this.page(urbanoLookupUrl(asked), { method: 'GET' }, signal, timeoutMs);
    const rows = parseUrbanoLookup(lookup, asked);
    const details = [];
    for (const row of rows.filter(hasGuide)) {
      const html = await this.page(URBANO_DETAIL, {
        method: 'POST', headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
          Referer: urbanoLookupUrl(asked),
        },
        body: new URLSearchParams({ accion: 'getDetalle', param1: row.data }).toString(),
      }, signal, deadline - Date.now());
      details.push(parseUrbanoDetail(html));
    }
    return urbanoResult(rows, details);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const asked = normalizeUrbanoNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a page is never sent again.
    return runSteps({ carrier: 'urbano-ar', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(asked, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(asked, signal, remainingMs)),
    ]);
  }
}

// No recognition: a shipper's four digits and a code of its own are a shape many carriers share
// and no rule offers Urbano Argentina, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new UrbanoArTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'urbano-ar', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
