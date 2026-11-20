import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { manifestStatus, stages } from './status.js';

export const provider = 'transportes-agael';

function city(value: string | undefined): string | undefined {
  const location = clean(value ?? '');
  return /^[\p{L} .'-]{2,45}$/u.test(location) && !hasPrivateDeliveryDetails(location) ? location : undefined;
}

export function parseTracking(body: string, number: string): CarrierResult {
  const $ = load(body);
  if (!clean($('title').first().text()).endsWith('| Transportes AGAEL')
    || !$('#trackingSearch input[name="codigo"]').length) {
    throw new SchemaError(provider, 'Transportes AGAEL did not return its public tracking portal');
  }
  const board = $('#shipmentDashboard');
  if (!board.length) throw new NotFoundError(provider);
  if (clean(board.find('#shipmentCode').text()).toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'Transportes AGAEL did not return the requested guide');
  }

  const movements = new Map<string, CarrierEvent & { stage?: Stage }>();
  for (const heading of $('.tracking-content .history-card .history-head').toArray()) {
    const row = $(heading);
    const description = clean(row.find('h3').text());
    const stage = stages.get(description);
    if (!stage && description !== manifestStatus) continue;
    const localClock = DateTime.fromFormat(clean(row.find('time').text()), 'dd/MM/yyyy HH:mm', { zone: 'UTC' });
    if (!localClock.isValid) continue;

    const location = description === 'Registrado' ? city(board.attr('data-origin'))
      : description === 'En destino' ? city(board.attr('data-destination')) : undefined;
    const localTime = localClock.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    movements.set(JSON.stringify([localTime, description, location]), {
      local_time: localTime, description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }
  const history = [...movements.values()].sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const current = clean(board.attr('data-status') ?? '');
  const statusText = stages.has(current) || current === manifestStatus ? current : undefined;
  const latest = history[0];
  const stage = (statusText ? stages.get(statusText) : undefined) ?? history.find(event => event.stage)?.stage;
  if (!statusText && !latest) {
    throw new IndeterminateError(provider, 'Transportes AGAEL listed the guide without usable tracking details', { reason: 'listed' });
  }
  const statusEvent = statusText ? history.find(event => event.description === statusText) : latest;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: statusText ?? latest?.description,
    ...(statusEvent && { last_update_local: statusEvent.local_time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
