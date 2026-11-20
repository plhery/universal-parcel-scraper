import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { scanStage } from './status.js';

export const provider = 'sinotrans-container-lines';

function assertOpen(body: string) {
  if (/cf-chl|hcaptcha\.com|__jsl_clearance|<title>\s*(?:Access Denied|Please Wait|Just a moment)/i.test(body)) {
    throw new ChallengeError(provider, 'Sinotrans requires verification');
  }
}

export function parseFormState(body: string): URLSearchParams {
  assertOpen(body);
  const $ = load(body);
  const form = $('form#form1');
  const values = new URLSearchParams();
  for (const name of ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__VIEWSTATEENCRYPTED', '__EVENTVALIDATION']) {
    const value = form.find(`input[type=hidden][name="${name}"]`).attr('value');
    if (value !== undefined) values.set(name, value);
  }
  if (!values.get('__VIEWSTATE') || !form.find('#dl_seltype option[value=cntrno]').length) {
    throw new SchemaError(provider, 'Sinotrans did not return the public equipment search form');
  }
  return values;
}

export function parseTracking(body: string, container: string): CarrierResult {
  assertOpen(body);
  const $ = load(body);
  const table = $('table#CntrStateGridView');
  if (!table.length) {
    if ($('#TbBlno').attr('value') === container
        && $('script').toArray().some(script => $(script).text().includes(`content:'${container} No Data!'`))) {
      throw new NotFoundError(provider);
    }
    throw new SchemaError(provider, 'Sinotrans did not return a container result');
  }

  const rows = table.find('tr').filter((_index, row) => $(row).children('td').length > 0).toArray();
  const events = rows.map(row => {
    const cells = $(row).children('td');
    const number = cells.eq(1).find('a[id^=CntrStateGridView_SelHL_]').text().trim().toUpperCase();
    if (number !== container) throw new IndeterminateError(provider, 'Sinotrans returned movements for a different container');

    const description = cells.eq(3).find('span[id^=CntrStateGridView_MOVENAMEL_]').text().trim();
    const location = cells.eq(4).find('span[id^=CntrStateGridView_PORTL_]').text().trim();
    const loadState = cells.eq(6).text().trim();
    const clock = cells.eq(7).text().trim();
    if (!description || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(clock)
        || !DateTime.fromSQL(clock, { zone: 'utc' }).isValid) {
      throw new SchemaError(provider, 'Sinotrans returned a malformed movement row');
    }

    const stage = scanStage(description, loadState);
    return {
      local_time: clock.replace(' ', 'T') + (clock.length === 16 ? ':00' : ''),
      description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Sinotrans listed the equipment without dated movements', { reason: 'listed' });
  return {
    status: latest.stage ? languageStageStatus(latest.stage) : 'unknown',
    ...(latest.stage && { current_stage: latest.stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description,
    last_update_local: latest.local_time,
    events,
  };
}
