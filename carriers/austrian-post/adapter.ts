
import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { clean, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { austrianPostEventStatus, austrianPostShowsEstimate, austrianPostSummaryStatus } from './status.js';

const PROVIDER = 'Austrian Post';
// Published in the official tracking form's data-sendungsapiurlpublic attribute;
// the official client calls this read without the optional account token.
const ENDPOINT = 'https://api.post.at/sendungen/sv/graphqlPublic';
const ZONE = 'Europe/Vienna';

type Estimate = Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> & { end: number };

function viennaDay(timestamp: number): DateTime {
  return DateTime.fromMillis(timestamp, { zone: ZONE }).startOf('day');
}

/**
 * The delivery estimate, read as the tracking page reads it: `startDate` and
 * `endDate` are days on Vienna time, and `startTime` and `endTime`, which carry
 * offsets, make a window when they fall on those days. Otherwise the days stand.
 */
function estimateOf(range: unknown): Estimate | null {
  if (!isRecord(range)) return null;
  const first = isoTime(range.startDate, ZONE);
  const last = range.endDate == null ? first : isoTime(range.endDate, ZONE);
  if (!first || !last) return null;
  const from = viennaDay(first.timestamp);
  const to = viennaDay(last.timestamp);
  if (+to < +from) return null;
  const start = explicitOffsetTime(range.startTime);
  const end = explicitOffsetTime(range.endTime);
  if (start && end && start.timestamp <= end.timestamp
    && +viennaDay(start.timestamp) === +from && +viennaDay(end.timestamp) === +to) {
    return { expected_delivery: end.iso, ...(start.timestamp < end.timestamp ? { expected_delivery_from: start.iso } : {}), end: end.timestamp };
  }
  const fromDay = from.toISODate();
  const toDay = to.toISODate();
  if (!fromDay || !toDay) return null;
  return { expected_delivery: toDay, ...(fromDay !== toDay ? { expected_delivery_from: fromDay } : {}), end: to.endOf('day').toMillis() };
}

export function normalizeAustrianPostNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{22}$/.test(number) && !(/^[A-Z]{2}\d{9}AT$/.test(number) && isValidS10TrackingNumber(number))) {
    throw new InvalidInputError(PROVIDER, 'Austrian Post requires a 22-digit or valid AT postal identifier');
  }
  return number;
}

export function parseAustrianPostResponse(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeAustrianPostNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  if (Array.isArray(payload.errors) && payload.errors.length) throw new IndeterminateError(PROVIDER, 'Austrian Post could not complete its tracking query');
  if (!isRecord(payload.data) || !Object.hasOwn(payload.data, 'einzelsendung')) throw new SchemaError(PROVIDER);
  const parcel = payload.data.einzelsendung;
  // This is the official client's positive not-found signature.
  if (parcel === null) throw new NotFoundError(PROVIDER);
  if (!isRecord(parcel) || clean(parcel.sendungsnummer, 64) !== number) throw new SchemaError(PROVIDER, 'Austrian Post returned a different shipment');
  if (!Array.isArray(parcel.sendungsEvents) || parcel.sendungsEvents.length > 500) throw new SchemaError(PROVIDER, 'Austrian Post returned invalid tracking history');
  const parsed: Array<{ event: CarrierEvent; timestamp: number; index: number }> = [];
  const seen = new Set<string>();
  // The tracking page takes the newest scan's reason from the feed's order, oldest first.
  let newestReason = '';
  parcel.sendungsEvents.forEach((raw, index) => {
    if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Austrian Post returned an invalid scan');
    const reason = clean(raw.reasontypecode, 32);
    newestReason = reason;
    const time = explicitOffsetTime(raw.timestamp);
    if (!time) throw new SchemaError(PROVIDER, 'Austrian Post returned an incomplete scan');
    const description = clean(raw.trackingDesc, 500);
    const code = clean(raw.status, 32);
    const providerCode = /^[A-Z0-9]{1,8}$/.test(code) ? code : '';
    // The tracking page lists a scan without wording under its date and time
    // alone, with no label from its codes. It keeps its code but no stage; one
    // without a code is skipped.
    if (!description && !providerCode) return;
    // A bare `PLZ 1234` is the delivery area; a facility keeps its name without the postcode.
    const location = clean(raw.eventPlaceName, 200).replace(/(?:^|,\s*)PLZ\s*\d{4,5}$/i, '').trim();
    const mapped = description ? austrianPostEventStatus(code, reason, description) : undefined;
    const key = JSON.stringify([time.iso, location, description, description ? '' : providerCode]);
    if (seen.has(key)) return;
    seen.add(key);
    parsed.push({ event: {
      time: time.iso, ...(description ? { description } : {}), ...(location ? { location } : {}),
      ...(mapped ? { stage: mapped.stage } : {}), ...(providerCode ? { provider_code: providerCode } : {}),
    }, timestamp: time.timestamp, index });
  });
  parsed.sort((a, b) => b.timestamp - a.timestamp || b.index - a.index);
  const events = parsed.slice(0, 100).map(({ event }) => event);
  const summary = clean(parcel.status, 32);
  const mapped = austrianPostSummaryStatus(summary);
  if (!events.length) throw new IndeterminateError(PROVIDER, 'Austrian Post returned a shipment without tracking history');
  const estimate = austrianPostShowsEstimate(summary, newestReason) ? estimateOf(parcel.estimatedDelivery) : null;
  // A later scan than the estimate's end leaves it stale.
  const expected = estimate && estimate.end >= parsed[0]!.timestamp ? estimate : null;
  const weight = typeof parcel.weight === 'number' && Number.isFinite(parcel.weight) && parcel.weight > 0 ? parcel.weight : null;
  // Whole centimetres; a missing side means the parcel was not measured.
  const sides = isRecord(parcel.dimensions) ? [parcel.dimensions.length, parcel.dimensions.width, parcel.dimensions.height] : [];
  const measured = sides.length === 3 && sides.every((side) => Number.isInteger(side) && (side as number) > 0 && (side as number) < 10_000);
  const status = mapped?.status ?? 'unknown';
  const deliveredAt = status === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  // The newest wording; a scan without any never gives the status text.
  const text =events.find((event) => event.description)?.description ?? null;
  return {
    status, ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: text, last_update: events[0]!.time!, expected_delivery: expected?.expected_delivery ?? null,
    ...(expected?.expected_delivery_from ? { expected_delivery_from: expected.expected_delivery_from } : {}),
    ...(weight === null ? {} : { weight_kg: weight }),
    ...(measured ? { dimensions_text: `${sides.join(' × ')} cm` } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    events,
  };
}

export class AustrianPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; timeoutMs?: number; userAgent?: string } = {}) {}

  async fetch(rawNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAustrianPostNumber(rawNumber);
    const budgetMs = context.budgetMs ?? this.options.timeoutMs ?? 15_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Austrian Post timeout must be positive');
    context.signal?.throwIfAborted();
    const query = `query { einzelsendung(sendungsnummer: "${number}") { sendungsnummer status weight dimensions { length width height } estimatedDelivery { startDate endDate startTime endTime } sendungsEvents { timestamp status reasontypecode trackingDesc eventPlaceName } } }`;
    try {
      const { bytes } = await fetchBounded(ENDPOINT, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) }, body: JSON.stringify({ query }),
      }, {
        provider: PROVIDER, maxBytes: 1_000_000, timeoutMs: Math.max(1, Math.floor(budgetMs)),
        fetcher: (input, init) => (this.options.fetcher ?? fetch)(input, {
          ...init, signal: AbortSignal.any([...(context.signal ? [context.signal] : []), ...(init?.signal ? [init.signal] : [])]),
        }),
      });
      context.signal?.throwIfAborted();
      return parseAustrianPostResponse(parseJsonBytes(bytes, PROVIDER), number);
    } catch (error) {
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError(PROVIDER, 'Austrian Post tracking endpoint is unavailable', { cause: error });
      throw error;
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AustrianPostTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'austrian-post', steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeAustrianPostNumber(number))),
  };
};
