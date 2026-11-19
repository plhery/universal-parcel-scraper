import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { bhPostaStage } from './status.js';

export const PROVIDER = 'BH Pošta';
export const BH_POSTA_TRACKER = 'https://bhpwebout.posta.ba/trackwebapp/';
const BLOCKED = /<title>\s*(?:Access Denied|Just a moment|Attention Required|Bot Verification)|cf-chl-|cf-turnstile|g-recaptcha/i;
const HEADINGS = ['Datum i vrijeme', 'Zemlja', 'Lokacija', 'Događaj', 'Napomena'];
const STATES = ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION'];
function sameAction(action: string): boolean { try { return new URL(action, BH_POSTA_TRACKER).href === BH_POSTA_TRACKER; } catch { return false; } }

export function normalizeBhPostaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!isValidS10TrackingNumber(number)) throw new InvalidInputError(PROVIDER, 'BH Pošta tracks postal S10 item codes');
  return number;
}

function document(html: string) {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'BH Pošta returned a verification page');
  return load(html);
}

/** Fresh ASP.NET state, returned to the same official form only. */
export function bhPostaFormFields(html: string, raw: string): URLSearchParams {
  const number = normalizeBhPostaNumber(raw), $ = document(html), form = $('form#form1');
  if (form.length !== 1 || form.attr('method')?.toLowerCase() !== 'post'
    || !sameAction(form.attr('action') ?? '')
    || form.find('input[name="tbBrojPosiljke"]').length !== 1 || form.find('input[type="submit"][name="btnIzlistaj"]').length !== 1) {
    throw new SchemaError(PROVIDER, 'BH Pošta tracking form changed');
  }
  const fields = new URLSearchParams();
  for (const name of STATES) {
    const input = form.find(`input[type="hidden"][name="${name}"]`), value = input.attr('value');
    if (input.length !== 1 || !value || value.length > 100_000) throw new SchemaError(PROVIDER, 'BH Pošta returned incomplete form state');
    fields.set(name, value);
  }
  const submit = form.find('input[name="btnIzlistaj"]').attr('value');
  if (!submit || submit.length > 80) throw new SchemaError(PROVIDER, 'BH Pošta returned no search action');
  fields.set('tbBrojPosiljke', number);
  fields.set('btnIzlistaj', submit);
  return fields;
}

/** The office's wall clock; the page supplies no offset. */
export function parseBhPosta(html: string, raw: string): CarrierResult {
  const number = normalizeBhPostaNumber(raw), $ = document(html), input = $('input[name="tbBrojPosiljke"]');
  if (input.length !== 1 || $('#Label1').length !== 1) throw new SchemaError(PROVIDER, 'BH Pošta returned no tracking result');
  if (input.attr('value') !== number) throw new IndeterminateError(PROVIDER, 'BH Pošta answered for another item');
  const tables = $('#Label1 table');
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'BH Pošta returned no unique event table');
  const rows = tables.find('tr').toArray();
  const heading = clean($(rows[0]).text(), 160);
  if (heading !== `Pregled događaja za pošiljku broj: ${number}`) throw new IndeterminateError(PROVIDER, 'BH Pošta returned a table for another item');
  if (rows.length > 502) throw new SchemaError(PROVIDER, 'BH Pošta returned too many events');
  const events: CarrierEvent[] = [];
  for (const row of rows.slice(1)) {
    const cells = $(row).children('td,th').toArray().map(cell => clean($(cell).text(), 500));
    if (JSON.stringify(cells) === JSON.stringify(HEADINGS)) continue;
    if (cells.length !== 5) throw new SchemaError(PROVIDER, 'BH Pošta changed its event columns');
    const [written, country, office, wording] = cells;
    const date = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/.test(written!)
      ? DateTime.fromFormat(written!, 'dd.MM.yyyy HH:mm:ss', { zone: 'UTC' }) : null;
    if (!date?.isValid || date.toFormat('dd.MM.yyyy HH:mm:ss') !== written || !wording) {
      throw new SchemaError(PROVIDER, 'BH Pošta returned an invalid dated event');
    }
    const stage = bhPostaStage(wording), location = [office, country].filter(Boolean).join(', ');
    events.push({ local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description: wording,
      ...(location ? { location } : {}), ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) });
  }
  // The same heading and an empty table are the observed unknown reply, with
  // no explicit missing verdict. Keep it inconclusive for provider fallback.
  if (!events.length) throw new IndeterminateError(PROVIDER, 'BH Pošta returned an empty event table');
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events[0]!, stage = bhPostaStage(newest.description!);
  return { status: stage ? languageStageStatus(stage.stage) : 'unknown',
    ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events };
}
