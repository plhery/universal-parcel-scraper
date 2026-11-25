import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { statusMap } from './status.js';

export const PROVIDER = 'Domex Expreso';
export const TRACKING_URL = 'https://domex-online.iplus.com.do/lg-es/ut/Estatus.aspx';

/** A Domex guide as its tracker prints it: WX and twelve digits. */
export function domexGuide(raw: string): string {
  const guide = raw.trim().toUpperCase();
  if (!/^WX\d{12}$/.test(guide)) throw new InvalidInputError(PROVIDER, 'Domex Expreso tracking needs its WX guide number');
  return guide;
}

export function parseDomex(html: string, guide: string): CarrierResult {
  if (/_cf_chl_opt|cf-challenge|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i.test(html)) {
    throw new ChallengeError(PROVIDER);
  }
  const $ = load(html);
  const form = $('#frmDatos');
  const notice = clean($('#cphInfo_lInfo').text(), 120);
  const summary = $('#divEstatus');
  if (summary.length === 0 && form.attr('action') === `./Estatus.aspx?id=${guide}`) {
    if (/^tracking inv[aá]lido$/i.test(notice)) throw new NotFoundError(PROVIDER);
    if (!notice && $('#pFiltro #cphCuerpo_tbTracking_I').length === 1) {
      throw new IndeterminateError(PROVIDER, 'Domex Expreso returned its empty tracking form');
    }
  }
  const label = summary.find('#cphCuerpo_lRecepcion');
  if (summary.length !== 1 || label.length !== 1 || label.text().trim() !== guide) {
    throw new SchemaError(PROVIDER, 'Domex Expreso did not identify the requested guide');
  }

  const table = summary.find('#cphCuerpo_gvEstatus');
  const rows = table.find('tr[id^="cphCuerpo_gvEstatus_DXDataRow"]').toArray();
  if (table.length !== 1 || rows.length > 1000) throw new SchemaError(PROVIDER, 'Domex Expreso returned an unreadable history');
  if (rows.length === 0) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });

  const events = rows.map((row): CarrierEvent => {
    const lines = $(row).children('td').first().children('div');
    const description = clean(lines.first().text(), 180);
    const [date, time, location] = lines.eq(1).text().split('|').map(part => clean(part, 180));
    // UTC only validates the digits: the scans come from Miami and the Dominican Republic without an offset.
    const clock = date && time ? zonedTime(`${date} ${time}`, 'yyyy.MM.dd hh:mm a', 'UTC', { locale: 'en' }) : null;
    if (!description || !clock) throw new SchemaError(PROVIDER, 'Domex Expreso returned an incomplete scan');
    const stage = statusMap.stage(null, description);
    return {
      local_time: clock.iso.slice(0, 19),
      description,
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
  });

  // The tracker lists the newest scan first. Its progress bar is not read: it lags the scans.
  const stage = leadingScan(events, statusMap)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description,
    last_update: null,
    expected_delivery: null,
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
