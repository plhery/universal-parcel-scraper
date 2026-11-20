import { load } from 'cheerio';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { statusMap } from './status.js';

export const PROVIDER = 'Cargo X';
export const MISSING_SHIPMENT = 'Gönderi bulunamadı.';
const HISTORY = 'Parçalı gönderi hareketleri';
const PIECE_NUMBER = 'Parça takip numarası';
const MAX_EVENTS = 100;

export function normalizeCargoXNumber(raw: string): string {
  const number = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

export function parseCargoX(html: string, number: string, status: number): CarrierResult {
  const $ = load(html);
  const title = clean($('title').text(), 120);
  if (/_cf_chl_opt|cf-challenge|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i.test(html)) {
    throw new ChallengeError(PROVIDER);
  }
  if (status === 404 && title === 'Gönderi takibi | Cargo X' && clean($('main h1').text(), 120) === MISSING_SHIPMENT) {
    throw new NotFoundError(PROVIDER);
  }
  if (status !== 200 || title !== `Gönderi ${number} | Cargo X`) {
    throw new SchemaError(PROVIDER, 'Cargo X did not identify the requested shipment');
  }

  const panels = $('section').filter((_, section) =>
    $(section).children('div').first().find('span').toArray().some(span => clean($(span).text(), 120) === HISTORY));
  if (panels.length !== 1) throw new SchemaError(PROVIDER, 'Cargo X returned no shipment history panel');
  const pieces = panels.find('details').filter((_, piece) => $(piece).children('summary').find('span').toArray().some(label =>
    clean($(label).text(), 120) === PIECE_NUMBER && $(label).next('span').text().trim() === number));
  if (pieces.length > 1) throw new SchemaError(PROVIDER, 'Cargo X returned multiple histories for the same tracking number');
  if (pieces.length === 0) throw new NoHistoryError(PROVIDER, 'Cargo X listed the shipment without a matching piece', { reason: 'listed' });

  const lists = pieces.children('ol');
  const rows = lists.children('li').toArray();
  if (lists.length !== 1 || rows.length > 1000) throw new SchemaError(PROVIDER, 'Cargo X returned an unreadable history');
  if (rows.length === 0) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  const events = rows.map(row => {
    const time = zonedTime($(row).children('time').text(), 'dd MMMM yyyy HH:mm', 'Europe/Istanbul', { locale: 'tr' });
    const lines = $(row).children('div').children('p');
    const wording = clean(lines.first().text(), 160);
    if (!time || !wording) throw new SchemaError(PROVIDER, 'Cargo X returned an incomplete scan');
    const [location, detail] = clean(lines.eq(1).text(), 240).split(' · ', 2);
    const stage = statusMap.stage(null, wording);
    const event: CarrierEvent = {
      time: time.iso,
      description: wording,
      ...(detail ? { original_description: `${wording} · ${detail}` } : {}),
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return { event, at: time.timestamp };
  }).sort((left, right) => right.at - left.at).map(({ event }) => event);
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description,
    last_update: events[0]!.time,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
