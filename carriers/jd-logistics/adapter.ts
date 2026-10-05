import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeJdNumber, parseJdLogistics } from './parser.js';

// Request builder in the official international Tracking page's proxy client.
const ENDPOINT = 'https://lop-proxy.ochama.com/WayBillApi/queryOrderTraceBatchV1';
const HEADERS = {
  'Content-Type': 'application/json', 'LOP-DN': 'pro-intl-cms-interface.jdl.com',
  ClientInfo: '{"appName":"intl_cms","client":"m"}',
  AppParams: '{"appid":"intl-cms-interface-web","ticket_type":"pc"}',
};

export class JdLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeJdNumber(raw);
    return runSteps({ carrier: 'jd-logistics', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      try {
        const { bytes } = await fetchBounded(ENDPOINT, { method: 'POST', signal, headers: { ...HEADERS, 'User-Agent': userAgentOf(this.options.userAgent) },
          body: JSON.stringify([{ magicNoList: [number], clientIp: '$cooMrdGatewayIp$', lang: 'en', timeZone: 'UTC' }]),
        }, { provider: 'JD Logistics', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
        return parseJdLogistics(parseJsonBytes(bytes, 'JD Logistics'), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError('JD Logistics', 'JD Logistics tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new JdLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'jd-logistics', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
