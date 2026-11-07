import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { DETAIL_URL, MAX_BYTES, normalizeSeinoSuperExpressNumber, ORIGIN, parseSeinoSuperExpressPage, PROVIDER, seinoSuperExpressSummaryBody, SUMMARY_URL } from './parser.js';

function guestCookie(response: Response): string | undefined {
  const match = /(?:^|,\s*)JSESSIONID=([^;,\s]{1,256})(?=;|,|$)/.exec(response.headers.get('set-cookie') ?? '');
  return match ? `JSESSIONID=${match[1]}` : undefined;
}

export class SeinoSuperExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeSeinoSuperExpressNumber(raw);
    return runSteps({ carrier: 'seino-super-express', budgetMs: context.budgetMs ?? 20_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: async ({ signal, remainingMs }) => {
        const deadline = performance.now() + remainingMs;
        const left = (): number => {
          signal.throwIfAborted();
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new BudgetExceededError(PROVIDER, context.budgetMs ?? 20_000);
          return Math.max(1, Math.floor(remaining));
        };
        const read = async (url: string, body: URLSearchParams, cookie?: string) => {
          const timeoutMs = left();
          const { response, bytes } = await fetchBounded(url, { method: 'POST', body: body.toString(), signal,
            headers: { Accept: 'text/html', 'Accept-Language': 'ja-JP,ja;q=0.9',
              'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent),
              Origin: url === SUMMARY_URL ? 'https://www.seino.co.jp' : ORIGIN,
              Referer: url === SUMMARY_URL ? 'https://www.seino.co.jp/ssx/' : SUMMARY_URL,
              ...(cookie ? { Cookie: cookie } : {}) },
          }, { provider: PROVIDER, fetcher: this.options.fetcher,
            timeoutMs, maxBytes: MAX_BYTES, redirect: 'manual',
            allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410, 428] });
          signal.throwIfAborted();
          if (response.url && response.url !== url) throw new SchemaError(PROVIDER, 'SSX returned another tracking route');
          if ([401, 403, 428].includes(response.status) || response.headers.get('cf-mitigated') === 'challenge') {
            throw new ChallengeError(PROVIDER, 'SSX refused public tracking');
          }
          if (response.status !== 200) throw new TransportError(PROVIDER, 'SSX tracking is unavailable', { status: response.status });
          const type = response.headers.get('content-type') ?? '';
          if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) throw new SchemaError(PROVIDER, 'SSX returned no tracking HTML');
          const encoding = /charset\s*=\s*["']?([^;\s"']+)/i.exec(type)?.[1] ?? 'shift_jis';
          let html: string;
          try { html = decodeText(bytes, encoding).replace(/^\uFEFF/, ''); }
          catch { throw new SchemaError(PROVIDER, 'SSX returned an unsupported text encoding'); }
          return { response, html };
        };
        const summary = await read(SUMMARY_URL, seinoSuperExpressSummaryBody(number));
        const page = parseSeinoSuperExpressPage(summary.html, number, 'summary');
        left();
        if (!page.detailBody) return page.result;
        const detail = await read(DETAIL_URL, page.detailBody, guestCookie(summary.response));
        // The detail transaction list supplies the scan clocks, not the summary's current-status clock.
        const result = parseSeinoSuperExpressPage(detail.html, number, 'detail').result;
        left();
        return result;
      } },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SeinoSuperExpressTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'seino-super-express', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
