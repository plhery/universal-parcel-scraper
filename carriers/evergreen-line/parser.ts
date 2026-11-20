import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { scanStage } from './status.js';

export const provider = 'evergreen-line';

function readPage(html: string) {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(html)) {
    throw new ChallengeError(provider, 'ShipmentLink requires verification');
  }
  // The movement form sits inside a table. Preserve its input children as written.
  return load(html, { xml: { xmlMode: false } });
}

export function parseBill(html: string, number: string): { container: string; fields: URLSearchParams } {
  const $ = readPage(html);
  const missing = $('td').toArray().some(cell =>
    $(cell).text().trim() === 'No information on B/L No., please enter a valid B/L No. or contact our offices for assistance.');
  const echoes = $('input[type=hidden][name=BL]').map((_, input) => $(input).attr('value')).get().filter(Boolean);
  if (missing && echoes.length === 1 && echoes[0] === number) throw new NotFoundError(provider);

  const bill = $('th').filter((_, cell) => $(cell).text().trim() === 'B/L No.').next('td');
  if (bill.length !== 1) throw new SchemaError(provider, 'ShipmentLink omitted the bill of lading');
  if (bill.text().trim().replace(/\s+/g, '') !== `EGLV${number}`) {
    throw new IndeterminateError(provider, 'ShipmentLink answered for a different bill of lading');
  }

  const count = $('th').filter((_, cell) => $(cell).text().trim() === 'Container Count').next('td').text().trim();
  if (/^(?:0|[2-9]|\d{2,})$/.test(count)) {
    throw new IndeterminateError(provider, 'ShipmentLink did not return a single-container bill', { reason: 'listed' });
  }
  const links = $('a[href^="javascript:frmCntrMoveDetail("]');
  const container = links.text().trim();
  if (count !== '1' || links.length !== 1 || !/^[A-Z]{4}\d{7}$/.test(container)
      || links.attr('href') !== `javascript:frmCntrMoveDetail('${container}');`) {
    throw new SchemaError(provider, 'ShipmentLink omitted the container movement link');
  }

  const form = $('form[name=frmCntrMove]');
  if (form.length !== 1 || form.attr('action') !== '/servlet/TDB1_CargoTracking.do') {
    throw new SchemaError(provider, 'ShipmentLink omitted the container movement form');
  }
  const movementField = (name: string) => form.find(`input[type=hidden][name=${name}]`).attr('value') ?? '';
  const onboardDate = movementField('onboard_date');
  const pol = movementField('pol');
  const pod = movementField('pod');
  const podCountry = movementField('podctry');
  if (movementField('bl_no') !== number || movementField('TYPE') !== 'CntrMove'
      || !/^\d{8}$/.test(onboardDate) || !/^[A-Z0-9]{5}$/.test(pol) || !/^[A-Z0-9]{5}$/.test(pod)
      || !/^[A-Z]{2}$/.test(podCountry)) {
    throw new SchemaError(provider, 'ShipmentLink returned invalid container movement fields');
  }
  return {
    container,
    fields: new URLSearchParams({
      TYPE: 'CntrMove', bl_no: number, cntr_no: container,
      onboard_date: onboardDate, pol, pod, podctry: podCountry,
    }),
  };
}

export function parseMovements(html: string, container: string): CarrierResult {
  const $ = readPage(html);
  const heading = $('td[colspan]').filter((_, cell) => /^Container Moves\s*:/.test($(cell).text().trim()));
  if (heading.length !== 1) throw new SchemaError(provider, 'ShipmentLink omitted the container history table');
  if (heading.find('font').text().trim() !== container) {
    throw new IndeterminateError(provider, 'ShipmentLink answered for a different container');
  }

  const rows = heading.parent('tr').nextAll('tr');
  const columns = rows.first().children('th').map((_, cell) => $(cell).text().trim()).get();
  if (columns.join('|') !== 'Date|Container Moves|Location|Vessel Voyage') {
    throw new SchemaError(provider, 'ShipmentLink changed the container movement columns');
  }
  const events = rows.slice(1).toArray().map(row => {
    const cells = $(row).children('td');
    const date = cells.eq(0).text().trim();
    const day = /^[A-Z]{3}-\d{2}-\d{4}$/.test(date)
      ? DateTime.fromFormat(date, 'MMM-dd-yyyy', { locale: 'en', zone: 'utc' }).toISODate() : null;
    const description = cells.eq(1).text().trim();
    const location = cells.eq(2).text().trim();
    if (cells.length !== columns.length || !day || !description) {
      throw new SchemaError(provider, 'ShipmentLink returned an invalid movement');
    }
    const stage = scanStage(description);
    return {
      local_time: day, description, ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).reverse();

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'ShipmentLink listed the container without movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
