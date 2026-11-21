import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EMO_TRANS_MAX_BYTES, emoTransSearchRow, normalizeEmoTransNumber, parseEmoTransShipment, PROVIDER } from './parser.js';

export { emoTransSearchRow, normalizeEmoTransNumber, parseEmoTransShipment } from './parser.js';

/** The quick track page, which also answers its table's search. */
export const EMO_TRANS_QUICK_TRACK = 'https://portal.emotrans-global.com/track/quicktrack';
/** A shipment's page, by the id the search gives it. */
export const emoTransShipmentUrl = (gid: number, number: string): string =>
  `${EMO_TRANS_QUICK_TRACK}/shipment/${gid}?search=${encodeURIComponent(number)}`;
const DEFAULT_BUDGET_MS = 20_000;
// A redirect, to a login or an error page, or a missing page is a moved portal, not a missing shipment: the search
// answers an unknown number with an empty list, and the shipment's page is the one the search just named.
const MOVED = [301, 302, 303, 307, 308, 404, 410];
// The page's table columns, as its DataTables script names them.
const COLUMNS = [['mode', 'mode'], ['shipmentNumber', 'shipmentNo'], ['houseBillNumber', 'houseBillNumber'], ['masterBillNumber', 'masterBillNumber']] as const;

/**
 * The search the quick track's table sends: DataTables' whole server-side request, sorted by
 * house bill as the page sorts it, and the number. The server answers an error page to a
 * request that leaves out the columns.
 */
export function emoTransSearchBody(number: string): URLSearchParams {
  const body = new URLSearchParams({ draw: '1' });
  COLUMNS.forEach(([data, name], index) => {
    const column = `columns[${index}]`;
    const fields: [string, string][] = [['data', data], ['name', name], ['searchable', 'true'], ['orderable', 'true'], ['search][value', ''], ['search][regex', 'false']];
    for (const [key, value] of fields) body.append(`${column}[${key}]`, value);
  });
  const rest: [string, string][] = [['order[0][column]', '2'], ['order[0][dir]', 'desc'], ['start', '0'], ['length', '10'],
    ['search[value]', ''], ['search[regex]', 'false'], ['shipmentIdentifier', number]];
  for (const [key, value] of rest) body.append(key, value);
  return body;
}

export class EmoTransTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    // The labels the parser reads are English, the portal's language without its locale cookie.
    const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Cookie: 'trackLocale=en' };
    const options = { provider: PROVIDER, maxBytes: EMO_TRANS_MAX_BYTES, fetcher: this.options.fetcher, redirect: 'manual' as const, allowHttpStatuses: MOVED };
    const moved = (response: Response) => {
      if (MOVED.includes(response.status)) throw new TransportError(PROVIDER, 'EMO Trans quick track moved', { status: response.status });
    };
    const search = await fetchBounded(EMO_TRANS_QUICK_TRACK, { method: 'POST', signal, body: emoTransSearchBody(number), headers: {
      ...headers, Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    } }, { ...options, timeoutMs: left() });
    moved(search.response);
    if (!/^application\/json\b/i.test(search.response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'EMO Trans answered its search with a page instead of its results');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(decodeText(search.bytes));
    } catch (error) {
      throw new SchemaError(PROVIDER, 'EMO Trans returned search results that are not JSON', { cause: error });
    }
    const row = emoTransSearchRow(payload, number);
    if (!row) throw new NotFoundError(PROVIDER, 'EMO Trans has no shipment under this number');
    // The search gives no events: the shipment's page, which the page's script opens for a single result, lists them.
    const page = await fetchBounded(emoTransShipmentUrl(row.gid, number), { signal, headers: { ...headers, Accept: 'text/html' } },
      { ...options, timeoutMs: left() });
    moved(page.response);
    return parseEmoTransShipment(decodeText(page.bytes), row);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEmoTransNumber(raw);
    // A read that fails to reach the portal, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EmoTransTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
