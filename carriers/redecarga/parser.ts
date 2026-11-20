import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { redecargaStage } from './status.js';

const carrier = 'redecarga';
export const SEARCH_URL = 'https://redecarga.gelotra.com/rastrearguia';

function localClock(value: string): string {
  const match = /^\d{4}-\d{2}-\d{2} (?:\d{2}:\d{2})(:\d{2}| [AP]M)?$/.exec(value);
  if (!match) throw new SchemaError(carrier, 'Redecarga returned an invalid scan clock');
  const suffix = match[1];
  const format = suffix?.startsWith(' ') ? 'yyyy-MM-dd hh:mm a' : suffix ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd HH:mm';
  const date = DateTime.fromFormat(value, format, { zone: 'UTC', locale: 'en' });
  if (!date.isValid) throw new SchemaError(carrier, 'Redecarga returned an invalid scan clock');
  return date.toFormat(suffix?.startsWith(':') ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm");
}

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Redecarga returned a browser check');
  }
  const $ = load(html);
  const form = $('form[action="/rastrearguia"]');
  if (clean($('title').text()) !== 'Rastreo de encomiendas' || form.length !== 1
    || $('img[alt="REDECARGA S.A.S."]').length !== 1 || clean(form.find('h1').text()) !== 'Rastrea tu envío') {
    throw new SchemaError(carrier, 'Redecarga changed its guest tracker');
  }
  if (form.find('#guia').length !== 1 || form.find('#guia').attr('value') !== number) {
    throw new IndeterminateError(carrier, 'Redecarga returned a different guide');
  }

  const result = $('.gel-rastreo-results');
  const timeline = result.find('table.gel-rastreo-timeline');
  if (result.length !== 1) throw new SchemaError(carrier, 'Redecarga omitted its tracking result');
  if (!timeline.length && clean(result.find('.gel-rastreo-empty').text()) === 'No se encontraron resultados. Verifica el número de guía e inténtalo de nuevo.') {
    throw new NotFoundError(carrier);
  }
  const rows = timeline.children('tbody').children('tr');
  if (timeline.length !== 1 || !rows.length || rows.length > 500) {
    throw new SchemaError(carrier, 'Redecarga changed its guide timeline');
  }

  for (const anchor of $('a.gel-rastreo-download').toArray()) {
    const url = URL.parse($(anchor).attr('href') ?? '', SEARCH_URL);
    if (url?.pathname === '/rastreo/descargar' && url.searchParams.get('guia') !== number) {
      throw new IndeterminateError(carrier, 'Redecarga returned documents for a different guide');
    }
  }

  const events = rows.toArray().map((row): CarrierEvent => {
    const cells = $(row).children('td');
    const cell = cells.last();
    const stamp = cell.children('.fecha');
    const detail = cell.children('.detalle');
    const label = detail.length
      ? detail.contents().filter((_, node) => node.nodeType === 3).text()
      : cell.contents().filter((_, node) => node.nodeType === 3).text();
    const description = clean(label, 180).replace(/\s*-$/, '');
    if (cells.length !== 2 || stamp.length !== 1 || !description) {
      throw new SchemaError(carrier, 'Redecarga changed its scan fields');
    }
    const stage = redecargaStage(description);
    return {
      local_time: localClock(clean(stamp.text(), 35)), description,
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    };
  }).reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));

  const latest = events[0]!;
  const stage = redecargaStage(latest.description!);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time,
    expected_delivery: null, events: events.slice(0, 100),
    ...(events.length > 100 && { history_truncated: true }),
  };
}
