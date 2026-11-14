import { accepted, readerLanguage, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, IndeterminateError, NotFoundError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DPDTracker } from '../dpd/adapter.js';
import { normalizeDpdPlNumber, parseDpdPl, PROVIDER, validateDpdPlBootstrap } from './parser.js';
import { dpdPlEnglish } from './status.js';

const ORIGIN = 'https://tracktrace.dpd.com.pl';
const COOKIE = /^(JSESSIONID|__cf_bm)=([A-Za-z0-9._~:=+/-]{1,512})(?:;|$)/;
/** The path that opens a session in each language the page words scans in. */
const LANGUAGES = { en: '/EN', pl: '' } as const;

export type DpdPlLanguage = keyof typeof LANGUAGES;

/** DPD Poland's own waybill, thirteen digits and a letter, as against a fourteen-digit DPD parcel number. */
const WAYBILL = /^\d{13}[A-Z]$/;

/** A lookup of a DPD Poland waybill in DPD's group-wide guest service. */
export type DpdPlGroupLookup = (waybill: string, context: TrackingContext) => Promise<CarrierResult>;

/** The session the search page opens. It holds the page's language, which the lookup answers in. */
function sessionCookie(response: Response): string {
  const cookies = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const match = COOKIE.exec(header);
    if (match) cookies.set(match[1]!, `${match[1]}=${match[2]}`);
  }
  if (!cookies.has('JSESSIONID')) throw new IndeterminateError(PROVIDER, 'DPD Poland did not open an anonymous session');
  return [...cookies.values()].join('; ');
}

export class DpdPlTracker {
  constructor(private readonly options: {
    fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; group?: DpdPlGroupLookup;
  } = {}) {}

  /**
   * `language` words the scans. A Polish page with a wording the map has no
   * English for is asked again in English, which the map reads in full. A
   * waybill the tracker has no trace of is asked of DPD's group-wide guest
   * service, which holds some that the tracker does not show.
   */
  fetch(raw: string, context: TrackingContext = {}, language: DpdPlLanguage = 'en') {
    const number = normalizeDpdPlNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    const { group } = this.options;
    return runSteps({ carrier: 'dpd-pl', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER },
      [{ id: 'direct', run: async ({ signal, remainingMs }) => {
        signal.throwIfAborted();
        const deadline = performance.now() + remainingMs;
        const read = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
          const left = deadline - performance.now();
          if (left <= 0) throw new BudgetExceededError(PROVIDER, budgetMs);
          signal.throwIfAborted();
          const headers = { ...init.headers, 'User-Agent': userAgentOf(this.options.userAgent) };
          const { response, bytes } = await fetchBounded(`${ORIGIN}${path}`, { ...init, headers, signal }, {
            provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(left)), maxBytes: 1_000_000,
            redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 404, 410], fetcher: this.options.fetcher,
          });
          if (performance.now() >= deadline) throw new BudgetExceededError(PROVIDER, budgetMs);
          signal.throwIfAborted();
          // A missing page or a redirect says nothing about the parcel.
          if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'DPD Poland tracking is unavailable');
          return { response, html: decodeText(bytes) };
        };
        const lookup = async (lang: DpdPlLanguage) => {
          const page = await read(`${LANGUAGES[lang]}/findParcel`);
          validateDpdPlBootstrap(page.html);
          const reply = await read(`${LANGUAGES[lang]}/findPackage`, {
            method: 'POST', body: new URLSearchParams({ q: number, typ: '1' }),
            headers: { Cookie: sessionCookie(page.response), 'X-Requested-With': 'XMLHttpRequest' },
          });
          return parseDpdPl(reply.html, number);
        };
        const result = await lookup(language);
        // A Polish wording the map cannot read in English may be a scan only the English wording stages.
        if (language === 'pl' && !result.events?.every(event => dpdPlEnglish(event.description ?? ''))) {
          return lookup('en').catch(() => {
            context.signal?.throwIfAborted();
            return result;
          });
        }
        return result;
      } }, {
        id: 'group',
        enabled: Boolean(group) && WAYBILL.test(number),
        recovers: (error) => error instanceof NotFoundError,
        run: ({ signal, remainingMs }) => group!(number, { signal, budgetMs: remainingMs }),
      }]);
  }
}

export const adapter: AdapterFactory = environment => {
  // DPD's guest service answers for the whole group; Belgium's unit asks it alone.
  const group = new DPDTracker({ country: 'BE', fetcher: environment.fetcher, userAgent: environment.userAgent });
  const options = { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent };
  const tracker = new DpdPlTracker({ ...options, group: (waybill, context) => group.guest(waybill, context) });
  // Recognition reads DPD Poland's tracker alone.
  const own = new DpdPlTracker(options);
  return { id: 'dpd-pl', recordsSteps: true, steps: ['direct', 'group'],
    track: (input, context) => tracker.fetch(input.number, context, readerLanguage(input, ['pl']) ?? 'en'),
    recognize: (number, context) => recognizeFromLookup(() => own.fetch(number, context), () => accepted(() => normalizeDpdPlNumber(number))) };
};
