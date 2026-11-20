import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { stageForWording } from './status.js';

export const provider = 'westjet-cargo';
export const tracker = 'https://westjet.smartkargo.com/FrmAWBTracking.aspx';

const id = (name: string) => `#ctl00_ContentPlaceHolder1_${name}`;

function readScans($: CheerioAPI, tableId: string, wording: string, dateColumn: string) {
  const table = $(id(tableId));
  if (!table.length) return [];
  if (table.length !== 1) throw new SchemaError(provider, 'WestJet Cargo returned multiple copies of an event table');
  const rows = table.find('tr').toArray();
  const columns = $(rows.shift()).children('th').toArray().map(cell => clean($(cell).text()));
  const descriptionIndex = columns.indexOf(wording);
  const dateIndex = columns.indexOf(dateColumn);
  const stationIndex = columns.indexOf('Station');
  if ([descriptionIndex, dateIndex, stationIndex].some(index => index === -1)) {
    throw new SchemaError(provider, 'WestJet Cargo changed its event columns');
  }
  return rows.map((row): CarrierEvent => {
    const cells = $(row).children('td').toArray().map(cell => clean($(cell).text()));
    const description = cells[descriptionIndex];
    const clock = cells[dateIndex];
    const location = cells[stationIndex];
    if (cells.length !== columns.length || !description || !clock || !/^[A-Z]{3}$/.test(location ?? '')) {
      throw new SchemaError(provider, 'WestJet Cargo returned an incomplete event');
    }
    const time = DateTime.fromFormat(clock, 'MM/dd/yyyy HH:mm', { zone: 'UTC' });
    if (!time.isValid) throw new SchemaError(provider, 'Invalid WestJet Cargo event clock');
    const stage = stageForWording(description);
    return {
      description, location,
      local_time: time.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      ...(stage ? { stage, stage_source: 'explicit_mapping' } : {}),
    };
  });
}

export function parseTracking(html: string, reference: string): CarrierResult {
  const $ = load(html);
  if (/^(?:Just a moment|Access Denied|Verification required)/i.test(clean($('title').text()))
    || $('.g-recaptcha, iframe[src*="recaptcha"], form#challenge-form').length) {
    throw new ChallengeError(provider, 'WestJet Cargo returned a verification page');
  }
  const identity = $(id('lblAWBNo'));
  if (!identity.length && clean($(id('LabelStatus')).text()) === 'No Records Found'
    && $(id('txtPrefix')).val() === reference.slice(0, 3)
    && $(id('TextBoxAWBno')).val() === reference.slice(3)) {
    throw new NotFoundError(provider);
  }
  if (identity.length !== 1) throw new SchemaError(provider, 'WestJet Cargo omitted a unique air waybill');
  if (clean(identity.text()).replace('-', '') !== reference) {
    throw new IndeterminateError(provider, 'WestJet Cargo replied to another air waybill');
  }

  const events = [
    ...readScans($, 'gvBkAcInfo', 'Status', 'Event Date-Time'),
    ...readScans($, 'GridViewAwbTracking', 'Milestone', 'Event DateTime(LT)'),
  ].sort((left, right) => (right.local_time ?? '').localeCompare(left.local_time ?? ''));
  const newest = events[0];
  const summary = clean($(id('lblLatestActivity')).text());
  if (!newest && !summary) throw new NoHistoryError(provider);
  const stage = stageForWording(summary) ?? (newest?.description && stageForWording(newest.description));
  const weight = /^(\d+(?:\.\d+)?) Kgs?$/i.exec(clean($(id('lblGrossWt')).text()));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'explicit_mapping' } : {}),
    ...(weight ? { weight_kg: Number(weight[1]) } : {}),
    last_status_text: summary || newest?.description,
    last_update: null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : { summary_only: true }),
    events,
  };
}
