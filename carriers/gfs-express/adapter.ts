import { createHash } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeGfsNumber, parseGfs, PROVIDER } from './parser.js';

const GATEWAY = 'https://gw.gfsxpress.com/gw';
const API = 'dwp.silk.outerPackageTracking';
const VERSION = '2';
const SITE = 'https://track.gfsxpress.com';
// The salt the tracking page's gateway script gives every visitor to sign its calls from a browser (`h5`).
const PAGE_SALT = 'E8748EF263C69EEE30A77CC6E0CD2CAC'; // gitleaks:allow

/** The query the tracking page sends: the call's data, the clock in milliseconds, and their MD5 signature with the page's salt. */
export function gfsQuery(number: string, at: number): URLSearchParams {
  const data = JSON.stringify({ sn: number, lan: 'en' });
  const ct = String(at);
  const sign = createHash('md5').update(`1${API}${VERSION}${data}${ct}${PAGE_SALT}`).digest('hex');
  return new URLSearchParams({ data, gw_ver: '1', ct, plat: 'h5', appname: 'gfs', sign });
}

export class GfsExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeGfsNumber(raw);
    return runSteps({ carrier: 'gfs-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { bytes } = await fetchBounded(`${GATEWAY}/${API}/${VERSION}?${gfsQuery(number, (this.options.now ?? Date.now)())}`, {
        signal, headers: { Accept: 'application/json, text/plain, */*', Origin: SITE, Referer: `${SITE}/`, 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) { throw new SchemaError(PROVIDER, 'GFS Express returned invalid tracking JSON', { cause }); }
      return parseGfs(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new GfsExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'gfs-express', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGfsNumber(number))) };
};
