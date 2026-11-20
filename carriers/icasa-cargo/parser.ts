import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { icasaStage } from './status.js';

const carrier = 'icasa-cargo';
const missing = 'No encontramos información para esta guía. Verificá el número e intentá de nuevo.';

function trackingDocument(html: string): ReturnType<typeof load> {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'ICASA returned a browser check');
  }
  return load(html);
}

export function readFormToken(html: string): string {
  const $ = trackingDocument(html);
  const form = $('main .rastreo-page form[action="/rastreo/"][method="POST"]');
  const token = form.find('input[name="csrfmiddlewaretoken"]').attr('value');
  if (form.length !== 1 || !token || !/^[A-Za-z0-9]{64}$/.test(token)
    || form.find('input[name="modo_envio"]').attr('value') !== 'aereo'
    || form.find('input[name="awb"]').length !== 1) {
    throw new SchemaError(carrier, 'ICASA changed its public air waybill form');
  }
  return token;
}

export function parseTracking(html: string, number: string): CarrierResult {
  const $ = trackingDocument(html);
  const page = $('main .rastreo-page');
  if (page.length === 1 && page.find('.alert-clean').toArray().some(el => clean($(el).text()) === missing)) {
    throw new NotFoundError(carrier);
  }
  const reference = page.find('.stat-card .stat-label')
    .filter((_, el) => clean($(el).text()) === 'Guía aérea').siblings('.stat-value');
  if (page.length !== 1 || reference.length !== 1) {
    throw new SchemaError(carrier, 'ICASA changed its air waybill summary');
  }
  if (clean(reference.text()) !== number) throw new IndeterminateError(carrier, 'ICASA returned a different air waybill');

  const tables = page.find('.data-card table.data-table');
  const bookings = tables.filter((_, table) => clean($(table).find('thead th').first().text()) === 'Estatus');
  const movements = tables.filter((_, table) => clean($(table).find('thead th').first().text()) === 'Movimiento');
  if (bookings.length > 1 || movements.length > 1 || bookings.length + movements.length === 0) {
    throw new SchemaError(carrier, 'ICASA changed its tracking tables');
  }
  const events: CarrierEvent[] = [];
  for (const [table, isMovement] of [[bookings, false], [movements, true]] as const) {
    const rows = table.find('tbody > tr');
    if (rows.length > 500) throw new SchemaError(carrier, 'ICASA returned too many tracking rows');
    for (const row of rows.toArray()) {
      const cells = $(row).children('td');
      const description = clean(cells.first().text(), 120);
      const stamp = clean(cells.eq(isMovement ? 3 : 4).text(), 40);
      const date = DateTime.fromFormat(stamp, 'd/M/yyyy H:mm', { locale: 'es-MX', zone: 'UTC' });
      if (cells.length !== 5 || !description || !date.isValid) {
        throw new SchemaError(carrier, 'ICASA changed its status or scan fields');
      }
      const location = isMovement ? clean(cells.eq(1).text(), 8) : '';
      const stage = icasaStage(description);
      events.push({
        description, local_time: date.toFormat("yyyy-MM-dd'T'HH:mm"),
        ...(/^[A-Z]{3}$/.test(location) && { location }),
        ...(stage && { stage, stage_source: 'explicit_mapping' }),
      });
    }
  }
  events.reverse().sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(carrier, 'ICASA omitted the shipment history');
  const stage = icasaStage(latest.description!);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time,
    expected_delivery: null, events: events.slice(0, 100),
    ...(events.length > 100 && { history_truncated: true }),
  };
}
