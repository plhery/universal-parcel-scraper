import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';

export interface SmartKargoPortal {
  provider: string;
  tracker: string;
  /** The airline prefix, or each airline prefix a shared tenant answers. */
  prefix: string | readonly string[];
  stageForWording: (wording: string) => Stage | undefined;
  /**
   * `link` opens the waybill from the tracker's `AWBPrefix` and `AWBNo` query, following one
   * redirect to the same page; `form` (the default) posts the tracker's ASP.NET form.
   */
  route?: 'form' | 'link';
}

export function normalizeSmartKargoNumber(raw: string, { provider, prefix }: SmartKargoPortal): string {
  const prefixes: readonly string[] = typeof prefix === 'string' ? [prefix] : prefix;
  const [, airline = '', serial = '', check = ''] = /^(\d{3})[- ]?(\d{7})(\d)$/.exec(raw.trim()) ?? [];
  if (!prefixes.includes(airline) || Number(serial) % 7 !== Number(check)) {
    throw new InvalidInputError(provider, `Enter a valid master air waybill beginning with ${prefixes.join(' or ')}`);
  }
  return airline + serial + check;
}

function document(html: string, provider: string) {
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required)|cf-chl-|g-recaptcha|cf-turnstile/i.test(html)) {
    throw new ChallengeError(provider, 'The tracker returned a verification page');
  }
  return load(html);
}

/** Some tenants render the tracker inside a master page, which prefixes every control id. */
const control = ($: CheerioAPI, name: string) => $(`#${name}, #ctl00_ContentPlaceHolder1_${name}`);

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

function readRows($: CheerioAPI, table: string, statusColumn: string, dateColumns: string[],
  { provider, stageForWording }: SmartKargoPortal): CarrierEvent[] {
  const rows = control($, table).find('tr').toArray();
  if (!rows.length) return [];
  const headings = $(rows[0]).children('th').toArray().map(cell => clean($(cell).text()));
  const station = headings.indexOf('Station');
  const status = headings.indexOf(statusColumn);
  const date = dateColumns.map(column => headings.indexOf(column)).find(index => index >= 0) ?? -1;
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

/** The latest activity the tracker's waybill list gives for the requested number. */
function listedActivity($: CheerioAPI, number: string): string {
  const button = $('[id$="_btnAWBNumber"]').toArray()
    .find(element => clean($(element).val()).replace(/[- ]/g, '') === number);
  const id = button && $(button).attr('id')?.replace(/btnAWBNumber$/, 'lblLatestActivity');
  return id ? clean($(`[id="${id}"]`).text()) : '';
}

export function parseSmartKargoTracking(html: string, number: string, portal: SmartKargoPortal): CarrierResult {
  const { provider, stageForWording } = portal;
  const $ = document(html, provider);
  const identity = clean(control($, 'lblAWBNo').text()).replace(/[- ]/g, '');
  if (!identity) {
    const prefix = control($, 'txtPrefix').val();
    const serial = clean(control($, 'TextBoxAWBno').val());
    if (prefix === number.slice(0, 3) && serial === number.slice(3)
      && ['AWB Details not available', 'No Records Found'].includes(clean(control($, 'LabelStatus').text()))) {
      throw new NotFoundError(provider);
    }
    throw new SchemaError(provider, 'The tracker omitted the air waybill');
  }
  if (identity !== number) throw new IndeterminateError(provider, 'The tracker returned another air waybill');

  const events = [
    ...readRows($, 'gvBkAcInfo', 'Status', ['Event Date-Time'], portal),
    // Without an event clock, the movement table's flight clock is the milestone's departure or arrival.
    ...readRows($, 'GridViewAwbTracking', 'Milestone', ['Event Date-Time', 'Flight Date'], portal),
  ].reverse().sort((left, right) => (right.local_time ?? '').localeCompare(left.local_time ?? ''));
  const newest = events[0];
  // The shipment panel and the waybill list can each lag behind the other; a delivery in either stands.
  const shown = clean(control($, 'lblLatestActivity').text());
  const listed = listedActivity($, number);
  const listedDelivery = stageForWording(listed) === 'delivered' && stageForWording(shown) !== 'delivered';
  const summary = !shown || listedDelivery ? listed : shown;
  const stage = stageForWording(summary) ?? (newest?.description && stageForWording(newest.description));
  if (!summary && !newest) throw new NoHistoryError(provider);
  const weight = /^(\d+(?:\.\d+)?) Kgs?$/i.exec(clean(control($, 'lblGrossWt').text()));
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
