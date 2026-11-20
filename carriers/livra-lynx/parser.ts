import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { withTieOrder } from '../../core/result/order.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { livraStatus } from './status.js';

const carrier = 'livra-lynx';

export function parseTracking(text: string, httpStatus: number, num: number): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Livra Lynx returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'Livra Lynx returned invalid tracking JSON');
  }
  if (httpStatus === 404 && isRecord(reply) && reply.success === false && reply.message === 'Colis non trouvé') {
    throw new NotFoundError(carrier);
  }
  if (httpStatus !== 200 || !isRecord(reply) || !Number.isSafeInteger(reply.num)
    || !Array.isArray(reply.timeline) || reply.timeline.length > 500) {
    throw new SchemaError(carrier, 'Livra Lynx changed its tracking reply');
  }
  if (reply.num !== num) throw new IndeterminateError(carrier, 'Livra Lynx returned a different parcel number');

  const providerCode = clean(reply.stage, 64);
  if (!providerCode) throw new SchemaError(carrier, 'Livra Lynx omitted the current parcel status');
  const current = livraStatus(providerCode);
  const timedEvents: { event: CarrierEvent; timestamp: number }[] = [];
  for (const item of reply.timeline as unknown[]) {
    if (!isRecord(item)) throw new SchemaError(carrier, 'Livra Lynx changed its tracking event');
    const code = clean(item.stage, 64);
    const time = explicitOffsetTime(item.date);
    if (!code || !time) throw new SchemaError(carrier, 'Livra Lynx changed its scan status or timestamp');
    const mapped = livraStatus(code);
    timedEvents.push({
      event: {
        provider_code: code, time: time.iso, description: mapped?.wording ?? code,
        ...(mapped && { stage: mapped.stage, stage_source: 'explicit_mapping' }),
      },
      timestamp: time.timestamp,
    });
  }
  timedEvents.reverse().sort((left, right) => right.timestamp - left.timestamp);
  const events = timedEvents.map(({ event }) => event);
  withTieOrder(events);
  if (!events.length && !current) throw new IndeterminateError(carrier, 'Livra Lynx returned no usable parcel status or history');
  const statusEvent = events.find((event) => event.provider_code === providerCode);
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current && { current_stage: current.stage, current_stage_source: 'explicit_mapping' }),
    provider_code: providerCode, last_status_text: current?.wording ?? providerCode, last_update: statusEvent?.time ?? null,
    events: events.slice(0, 100), ...(events.length > 100 && { history_truncated: true }),
    ...(!events.length && { summary_only: true }),
  };
}
