import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';

export interface SmartKargoPortal {
  provider: string;
  tracker: string;
  prefix: string;
  stageForWording: (wording: string) => Stage | undefined;
}

export function normalizeSmartKargoNumber(raw: string, { provider, prefix }: SmartKargoPortal): string {
  const match = /^(\d{3})[- ]?(\d{7})(\d)$/.exec(raw.trim());
  if (match?.[1] !== prefix || Number(match[2]) % 7 !== Number(match[3])) {
    throw new InvalidInputError(provider, `Enter a valid master air waybill beginning with ${prefix}`);
  }
  return prefix + match[2] + match[3];
}

function document(html: string, provider: string) {
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required)|cf-chl-|g-recaptcha|cf-turnstile/i.test(html)) {
    throw new ChallengeError(provider, 'The tracker returned a verification page');
  }
  return load(html);
}

export function smartKargoFormFields(html: string, number: string, { provider, tracker }: SmartKargoPortal): URLSearchParams {
  const $ = document(html, provider);
  const form = $('form#FrmAWBTracking');
  const action = form.attr('action');
  if (form.length !== 1 || (action !== './FrmAWBTracking.aspx' && action !== tracker)
    || form.attr('method')?.toLowerCase() !== 'post' || form.find('#txtPrefix, #TextBoxAWBno, #ButtonGO').length !== 3) {
    throw new SchemaError(provider, 'The tracking form changed');
  }
  const fields = new URLSearchParams();
  for (const name of ['ToolkitScriptManager1_HiddenField', '__VIEWSTATE', '__VIEWSTATEGENERATOR',
    '__VIEWSTATEENCRYPTED', '__EVENTVALIDATION', 'hdnIsAlaska']) {
    const value = form.find(`input[type="hidden"][name="${name}"]`).attr('value');
    if (value != null) fields.set(name, value);
  }
  if (!fields.get('__VIEWSTATE')) throw new SchemaError(provider, 'The tracker omitted tracking form state');
  fields.set('txtPrefix', number.slice(0, 3));
  fields.set('TextBoxAWBno', number.slice(3));
  fields.set('ButtonGO', 'Track');
  return fields;
}

function readRows($: CheerioAPI, table: string, statusColumn: string,
  { provider, stageForWording }: SmartKargoPortal): CarrierEvent[] {
  const rows = $(table).find('tr').toArray();
  if (!rows.length) return [];
  const headings = $(rows[0]).children('th').toArray().map(cell => clean($(cell).text()));
  const station = headings.indexOf('Station');
  const status = headings.indexOf(statusColumn);
  const date = headings.indexOf('Event Date-Time');
  if (station < 0 || status < 0 || date < 0) throw new SchemaError(provider, 'The tracker changed its event columns');
  return rows.slice(1).map(row => {
    const cells = $(row).children('td').toArray().map(cell => clean($(cell).text()));
    const description = cells[status];
    const written = cells[date];
    const location = cells[station];
    if (cells.length !== headings.length || !description || !written) {
      throw new SchemaError(provider, 'The tracker returned an incomplete event');
    }
    const time = DateTime.fromFormat(written, written.length === 16 ? 'dd/MM/yyyy HH:mm' : 'dd/MM/yyyy HH:mm:ss', { zone: 'UTC' });
    if (!time.isValid) throw new SchemaError(provider, 'The tracker returned an invalid event date');
    const stage = stageForWording(description);
    return {
      description, local_time: time.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'explicit_mapping' } : {}),
    };
  });
}

export function parseSmartKargoTracking(html: string, number: string, portal: SmartKargoPortal): CarrierResult {
  const { provider, stageForWording } = portal;
  const $ = document(html, provider);
  const identity = clean($('#lblAWBNo').text()).replace(/[- ]/g, '');
  if (!identity) {
    const prefix = $('#txtPrefix').val();
    const serial = clean($('#TextBoxAWBno').val());
    if (prefix === number.slice(0, 3) && serial === number.slice(3)
      && clean($('#LabelStatus').text()) === 'AWB Details not available') {
      throw new NotFoundError(provider);
    }
    throw new SchemaError(provider, 'The tracker omitted the air waybill');
  }
  if (identity !== number) throw new IndeterminateError(provider, 'The tracker returned another air waybill');

  const events = [
    ...readRows($, '#gvBkAcInfo', 'Status', portal),
    ...readRows($, '#GridViewAwbTracking', 'Milestone', portal),
  ].reverse().sort((left, right) => (right.local_time ?? '').localeCompare(left.local_time ?? ''));
  const newest = events[0];
  const summary = clean($('#lblLatestActivity').text());
  const stage = stageForWording(summary) ?? (newest?.description && stageForWording(newest.description));
  if (!summary && !newest) throw new NoHistoryError(provider);
  const weight = /^(\d+(?:\.\d+)?) Kgs?$/i.exec(clean($('#lblGrossWt').text()));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'explicit_mapping' } : {}),
    ...(weight ? { weight_kg: Number(weight[1]) } : {}),
    last_status_text: summary || newest?.description,
    last_update: null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    ...(!events.length ? { summary_only: true } : {}),
    events,
  };
}
