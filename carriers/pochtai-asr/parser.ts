import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { asrStage } from './status.js';

const carrier = 'pochtai-asr';

function localized(value: unknown, locale: 'en' | 'ru' | 'tg'): string {
  if (!isRecord(value)) return '';
  return clean(value[locale === 'tg' ? 'tj' : locale]) || clean(value.en) || clean(value.ru) || clean(value.tj);
}

export function parseTracking(
  text: string, number: string, httpStatus: number, language: 'en' | 'ru' | 'tg' = 'en',
): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Pochtai Asr returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    if (httpStatus === 404) throw new TransportError(carrier, 'The Pochtai Asr tracking endpoint returned HTTP 404');
    throw new SchemaError(carrier, 'Pochtai Asr returned invalid tracking JSON');
  }

  if (httpStatus === 404) {
    if (isRecord(reply) && isRecord(reply.error) && reply.error.code === 'NOT_FOUND'
      && reply.error.message === 'Shipment not found') throw new NotFoundError(carrier);
    throw new TransportError(carrier, 'The Pochtai Asr tracking endpoint returned HTTP 404');
  }
  if (!isRecord(reply) || !Array.isArray(reply.events) || reply.events.length > 500) {
    throw new SchemaError(carrier, 'Pochtai Asr changed its tracking response');
  }
  if (reply.track_number !== number) throw new IndeterminateError(carrier, 'Pochtai Asr returned a different waybill');

  const statusCode = clean(reply.status, 64);
  const statusText = localized(reply.status_label, language);
  if (!statusCode || !statusText) throw new SchemaError(carrier, 'Pochtai Asr omitted the waybill status');

  const scans = reply.events.map((event: unknown) => {
    if (!isRecord(event)) throw new SchemaError(carrier, 'Pochtai Asr changed its tracking history');
    const time = explicitOffsetTime(event.at);
    const code = clean(event.status, 64);
    const description = localized(event.status_label, language);
    const location = localized(event.city, language);
    if (!time || !code || !description) throw new SchemaError(carrier, 'Pochtai Asr changed its scan fields');
    const stage = asrStage(code);
    const parsed: CarrierEvent = {
      time: time.iso, description, provider_code: code, ...(location && { location }),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    };
    return { event: parsed, timestamp: time.timestamp };
  }).sort((a, b) => b.timestamp - a.timestamp);
  const events = scans.slice(0, 100).map(scan => scan.event);
  const stage = asrStage(statusCode);
  const delivery = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: statusText, provider_code: statusCode, last_update: events[0]?.time ?? null,
    expected_delivery: null, events,
    ...(delivery?.time && { delivered_at: delivery.time }),
    ...(!events.length && { summary_only: true }),
    ...(scans.length > 100 && { history_truncated: true }),
  };
}
