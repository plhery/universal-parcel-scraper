import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { logeximStage } from './status.js';

const carrier = 'logexim-express';
export const SEARCH_URL = 'https://www.logeximexpress.kz/nayti-posylku';

function checkChallenge(text: string): void {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Logexim Express returned a browser check');
  }
}

export function readFormToken(html: string): string {
  checkChallenge(html);
  const $ = load(html);
  const tokenField = $('meta[name="csrf-token"]');
  const token = tokenField.attr('content');
  if (clean($('title').text()) !== 'Найти посылку - Logexim Express'
    || $('form.track-form input[name="invoice_number"]').length !== 1
    || tokenField.length !== 1 || !token || !/^[a-z0-9]{32,128}$/i.test(token)) {
    throw new SchemaError(carrier, 'Logexim Express changed its guest tracking form');
  }
  return token;
}

function localClock(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const match = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(clean(value, 25));
  const day = match && calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  if (!match || !day || Number(match[4] ?? 0) > 23 || Number(match[5] ?? 0) > 59 || Number(match[6] ?? 0) > 59) {
    throw new SchemaError(carrier, 'Logexim Express returned an invalid local date');
  }
  return match[4] ? `${day}T${match[4]}:${match[5]}${match[6] ? ':' + match[6] : ''}` : day;
}

function event(description: string, localTime: string): CarrierEvent {
  const stage = logeximStage(undefined, description);
  return {
    local_time: localTime, description,
    ...(stage && { stage, stage_source: 'explicit_mapping' }),
  };
}

export function parseTracking(text: string, number: string): CarrierResult {
  checkChallenge(text);
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'Logexim Express returned invalid tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(carrier, 'Logexim Express changed its tracking response');
  if (reply.found === false && Object.keys(reply).length === 1) throw new NotFoundError(carrier);
  const invoice = reply.invoice;
  if (reply.found !== true || !isRecord(invoice) || typeof invoice.cancelled !== 'boolean'
    || typeof invoice.status !== 'number' || !Number.isSafeInteger(invoice.status)
    || !Array.isArray(invoice.detail_steps) || invoice.detail_steps.length > 50) {
    throw new SchemaError(carrier, 'Logexim Express changed its waybill record');
  }
  if (invoice.number !== number) throw new IndeterminateError(carrier, 'Logexim Express returned a different waybill');

  const administrativeStatus = clean(invoice.status_label, 150);
  const code = String(invoice.status);
  const events: CarrierEvent[] = [];
  let active = '';
  let completed = '';

  if (!invoice.cancelled) {
    for (const row of invoice.detail_steps as unknown[]) {
      if (!isRecord(row)) throw new SchemaError(carrier, 'Logexim Express changed its progress steps');
      const wording = clean(row.title, 150);
      if (!wording || (row.state !== 'done' && row.state !== 'current' && row.state !== 'pending')) {
        throw new SchemaError(carrier, 'Logexim Express changed its progress fields');
      }
      if (row.state === 'pending') continue;
      if (row.state === 'done') completed = wording;
      if (row.state === 'current' && !active) active = wording;
      const time = localClock(row.at);
      if (time) events.push(event(wording, time));
    }
    if (!invoice.detail_steps.length) {
      const created = localClock(invoice.created_at);
      if (created) events.push(event('Заявка создана', created));
    }
  }

  const delivered = invoice.cancelled ? undefined : localClock(invoice.fact_date);
  if (delivered && !events.some(scan => scan.stage === 'delivered')) events.push(event('Доставлена', delivered));
  events.reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const detailStatus = active || completed;
  const statusText = invoice.cancelled ? administrativeStatus || 'Отменена' : detailStatus || administrativeStatus;
  if (!statusText) throw new SchemaError(carrier, 'Logexim Express omitted the waybill status');
  const stage = invoice.cancelled ? 'exception'
    : delivered ? 'delivered' : logeximStage(detailStatus ? undefined : code, statusText);

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: statusText, ...(!detailStatus && { provider_code: code }),
    last_update: null, ...(events[0]?.local_time && { last_update_local: events[0].local_time }),
    expected_delivery: null, events, ...(!events.length && { summary_only: true }),
  };
}
