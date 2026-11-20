import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { vencedorStage } from './status.js';

const carrier = 'paqueteria-vencedor';
export const SEARCH_URL = 'https://www.grupovencedor.com/paqueteria';
export const SUBMIT_URL = 'https://www.grupovencedor.com/rastreo';

function trackingPage(html: string) {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Paquetería Vencedor returned a browser check');
  }
  const $ = load(html);
  if (clean($('title').text()) !== 'Paquetería | Grupo Vencedor') {
    throw new SchemaError(carrier, 'Paquetería Vencedor changed its tracking page');
  }
  return $;
}

export function readFormToken(html: string): string {
  const $ = trackingPage(html);
  const form = $('form[method="POST"]').filter((_index, node) => $(node).attr('action') === SUBMIT_URL);
  const fields = form.find('input[type="hidden"][name="_token"]');
  const token = fields.attr('value');
  if (form.length !== 1 || form.find('input[name="tracknumber"]').length !== 1
    || fields.length !== 1 || !token || !/^[a-z0-9]{32,128}$/i.test(token) || $('.tracking-result-header').length) {
    throw new SchemaError(carrier, 'Paquetería Vencedor changed its guest tracking form');
  }
  return token;
}

function localClock(wording: string): string {
  const timestamp = /^[\p{L}]+, (.+)$/u.exec(wording)?.[1];
  const date = DateTime.fromFormat(timestamp ?? '', "dd 'de' MMMM 'de' yyyy — HH:mm", { locale: 'es', zone: 'UTC' });
  if (!date.isValid) throw new SchemaError(carrier, 'Paquetería Vencedor returned an invalid scan clock');
  return date.toFormat("yyyy-MM-dd'T'HH:mm");
}

export function parseTracking(html: string, number: string): CarrierResult {
  const $ = trackingPage(html);
  const heading = $('.tracking-result-header .guia-number');
  if (heading.length !== 1 || clean(heading.contents().filter((_index, node) => node.nodeType === 3).text()) !== '#' + number) {
    // The missing-guide notice asks the reader to try later and does not repeat the number.
    throw new IndeterminateError(carrier, 'Paquetería Vencedor returned no matching guide');
  }
  const timeline = $('.tracking-timeline');
  const rows = timeline.children('.tracking-timeline-item');
  if (timeline.length !== 1 || !rows.length || rows.length > 500
    || !rows.first().hasClass('is-latest') || rows.filter('.is-latest').length !== 1) {
    throw new SchemaError(carrier, 'Paquetería Vencedor changed its tracking timeline');
  }

  const events = rows.toArray().map((node): CarrierEvent => {
    const row = $(node);
    const description = clean(row.find('h6').text(), 150);
    const clock = clean(row.find('small').text());
    const location = /^Oficina: (.+)$/.exec(clean(row.find('p').text()))?.[1];
    if (!description || row.find('h6').length !== 1 || row.find('small').length !== 1) {
      throw new SchemaError(carrier, 'Paquetería Vencedor changed its scan fields');
    }
    const stage = vencedorStage(description);
    return {
      local_time: localClock(clock), description, ...(location && { location }),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    };
  });

  const latest = events[0]!;
  const stage = vencedorStage(latest.description!);
  const summary = clean($('.tracking-result-header .tracking-status-pill').text());
  if (summary !== latest.description) {
    throw new IndeterminateError(carrier, 'Paquetería Vencedor returned inconsistent current statuses');
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: summary, last_update: null, last_update_local: latest.local_time!,
    expected_delivery: null, events: events.slice(0, 100),
    ...(events.length > 100 && { history_truncated: true }),
  };
}
