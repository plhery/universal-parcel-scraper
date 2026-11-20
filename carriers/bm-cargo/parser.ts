import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { statusMap } from './status.js';

export const PROVIDER = 'BM Cargo';
export const TRACKING_URL = 'https://bmcargo-online.iplus.com.do/lg-es/ut/Estatus.aspx';

export function bmCargoReceipt(raw: string): string {
  const parts = /^(WR\d{2})-?(\d{9})$/.exec(raw.trim().toUpperCase());
  if (!parts) throw new InvalidInputError(PROVIDER, 'BM Cargo tracking needs its warehouse receipt number');
  return `${parts[1]}-${parts[2]}`;
}

export function parseBmCargo(html: string, receipt: string): CarrierResult {
  if (/_cf_chl_opt|cf-challenge|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i.test(html)) {
    throw new ChallengeError(PROVIDER);
  }
  const $ = load(html);
  const summary = $('#divEstatus');
  if (summary.length === 0 && $('#pFiltro #cphCuerpo_tbTracking_I').length === 1
    && $('#frmDatos').attr('action') === `./Estatus.aspx?id=${receipt}`) {
    throw new IndeterminateError(PROVIDER, 'BM Cargo returned its empty tracking form');
  }
  const label = summary.find('#cphCuerpo_lRecepcion');
  if (summary.length !== 1 || label.length !== 1 || label.text().trim() !== receipt) {
    throw new SchemaError(PROVIDER, 'BM Cargo did not identify the requested receipt');
  }

  const table = summary.find('#cphCuerpo_gvEstatus');
  const rows = table.find('tr[id^="cphCuerpo_gvEstatus_DXDataRow"]').toArray();
  if (table.length !== 1 || rows.length > 1000) throw new SchemaError(PROVIDER, 'BM Cargo returned an unreadable history');
  if (rows.length === 0) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });

  const events = rows.map((row): CarrierEvent => {
    const lines = $(row).children('td').first().children('div');
    const description = clean(lines.first().text(), 180);
    const [date, time, location] = lines.eq(1).text().split('|').map(part => clean(part, 180));
    // UTC validates the clock digits; the feed gives no offset for scans at different sites.
    const clock = date && time ? zonedTime(`${date} ${time}`, 'yyyy.MM.dd hh:mm:ss a', 'UTC', { locale: 'en' }) : null;
    if (!description || !clock) throw new SchemaError(PROVIDER, 'BM Cargo returned an incomplete scan');
    const stage = statusMap.stage(null, description);
    return {
      local_time: clock.iso.slice(0, 19),
      description,
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
  });

  // The tracker lists newest scan first across the entire route.
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
