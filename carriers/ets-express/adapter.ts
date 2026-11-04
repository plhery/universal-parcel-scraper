import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ETS_ORIGIN, normalizeEtsNumber, parseEtsAbsencePage, parseEtsTrack, PROVIDER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const UNAVAILABLE = [404, 410];
const BLOCK = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|The requested URL was rejected|captcha|人机验证|滑动验证|安全验证|<title>\s*(?:访问受限|Access denied)/i;

export class EtsExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(url: URL, signal: AbortSignal, timeoutMs: number, body?: URLSearchParams): Promise<string> {
    const { response, bytes } = await fetchBounded(url, {
      method: body ? 'POST' : 'GET', signal,
      headers: { Accept: body ? 'text/html,application/xhtml+xml' : 'application/json, text/plain, */*',
        'User-Agent': userAgentOf(this.options.userAgent),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(body ? { body } : {}),
    }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs, maxBytes: body ? 1024 * 1024 : 512 * 1024,
      redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE] });
    if (REDIRECTS.includes(response.status) || UNAVAILABLE.includes(response.status)) {
      throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`);
    }
    // The public track interface is GBK; the tracking page declares UTF-8.
    const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]?.toLowerCase();
    const text = decodeText(bytes, charset === 'utf-8' || charset === 'utf8' || body ? 'utf-8' : 'gbk').replace(/^\uFEFF/, '');
    if (BLOCK.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a block page`);
    return text;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEtsNumber(raw);
    return await runSteps({ carrier: 'ets-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const url = new URL('/selectTrack.htm', ETS_ORIGIN);
      url.searchParams.set('documentCode', number);
      const text = await this.read(url, signal, left());
      let payload: unknown;
      try { payload = JSON.parse(text); } catch {
        throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not JSON`);
      }
      const result = parseEtsTrack(payload, number);
      if (result) return result;
      const html = await this.read(new URL('/trackIndex.htm', ETS_ORIGIN), signal, left(), new URLSearchParams({ documentCode: number }));
      return parseEtsAbsencePage(html, number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EtsExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'ets-express', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeEtsNumber(number))),
  };
};
