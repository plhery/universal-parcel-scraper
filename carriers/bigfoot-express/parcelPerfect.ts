import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { depotless, type StageOf } from './parcelPerfectStages.js';

type Tenant = 'bigfoot-express' | 'intertown-transport' | 'primetime-express';
type Parser = (text: string, number: string, httpStatus: number) => CarrierResult;

export function parcelPerfect(id: Tenant, origin: string, format: RegExp, parse: Parser): AdapterFactory {
  return environment => ({
    id, recordsSteps: true, steps: ['direct'],
    async track(input, context = {}) {
      const number = input.number.trim().toUpperCase();
      if (!format.test(number)) throw new InvalidInputError(id, 'Invalid waybill format');
      return runSteps({ carrier: id, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
        id: 'direct',
        async run({ signal, remainingMs }) {
          const headers = { 'User-Agent': userAgentOf(environment.userAgent) };
          const options = { provider: id, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 512 * 1024, allowHttpStatuses: [404, 410] };
          const config = await fetchBounded(origin + '/config/config.json', { signal, headers }, options);
          if (!config.response.ok) throw new SchemaError(id, 'Tenant configuration unavailable');
          let tenant: unknown;
          try { tenant = JSON.parse(decodeText(config.bytes)); }
          catch { throw new SchemaError(id, 'Tenant configuration is not JSON'); }
          if (!isRecord(tenant) || typeof tenant.cryptcust !== 'string' || !tenant.cryptcust) throw new SchemaError(id, 'Missing public tenant configuration');
          const query = new URLSearchParams({ class: 'Waybill', method: 'getEventData', token_id: tenant.cryptcust,
            params: JSON.stringify({ waybill: number, rectype: 'waybill' }) });
          const { bytes, response } = await fetchBounded(origin + '/trackappservice/Json/index.php?' + query.toString(), { signal, headers }, options);
          return parse(decodeText(bytes), number, response.status);
        },
      }]);
    },
  });
}

export function parcelPerfectHistory(id: Tenant, stageOf: StageOf): Parser {
  return (text, number, httpStatus) => {
    let reply: unknown;
    try { reply = JSON.parse(text); }
    catch { throw new SchemaError(id, 'Tracking service returned invalid JSON'); }
    if (httpStatus !== 200 || !isRecord(reply) || !Array.isArray(reply.results)) throw new SchemaError(id, 'Unexpected waybill response');
    if (reply.errorcode === '1' && reply.errormessage === 'Event data not found.' && reply.total === 0 && !reply.results.length) throw new NotFoundError(id);
    if (reply.errorcode !== '0' || reply.total !== reply.results.length) throw new SchemaError(id, 'Incomplete waybill response');
    let previous: Stage | undefined;
    const events: CarrierEvent[] = reply.results.flatMap((row: unknown) => {
      if (!isRecord(row) || row.waybill !== number) throw new IndeterminateError(id, 'Waybill mismatch');
      if (row.hidden) return [];
      const description = row.event;
      if (typeof row.eventdate !== 'string' || typeof row.eventtime !== 'string') throw new SchemaError(id, 'Invalid waybill clock');
      const clock = DateTime.fromISO(`${row.eventdate}T${row.eventtime}`, { zone: 'utc' });
      if (typeof description !== 'string' || !description.trim() || !clock.isValid) throw new SchemaError(id, 'Invalid waybill event');
      // Oldest first. The depot captures the consignment and marks it ready after the driver has collected it, and
      // "Dispatched" is a vehicle leaving, which after the parcel is loaded for delivery is the round: both keep the
      // stage the parcel has.
      const read = stageOf(description);
      const keep = previous && read && ((read.stage === 'registered' && previous !== 'registered')
        || (previous === 'out_for_delivery' && depotless(description) === 'dispatched'));
      const stage = keep ? { stage: previous!, source: 'carrier_map' } : read;
      if (stage) previous = stage.stage;
      return [{ description, local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        ...(typeof row.eventhub === 'string' && row.eventhub ? { location: row.eventhub } : {}),
        ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) }];
    }).reverse();
    const newest = events[0];
    if (!newest) throw new NoHistoryError(id);
    const stage = newest.stage as Stage | undefined;
    return { status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source! } : {}),
      last_status_text: newest.description!, last_update_local: newest.local_time!, events };
  };
}
