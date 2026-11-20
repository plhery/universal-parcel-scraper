import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { azulCargoStage } from './status.js';

export const PROVIDER = 'Azul Cargo Express';
export const AZUL_CARGO_MAX_BYTES = 3_000_000;
export const AZUL_CARGO_ZONE = 'America/Sao_Paulo';
const MAX_ROWS = 200;
// A leap day needs up to four years back.
const YEARS_BACK = 4;
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
// "14 de novembro - 17:13": a day, a month and a clock, without a year.
const CLOCK = /^(\d{1,2}) de ([a-zç]+) - (\d{1,2}):(\d{2})$/i;
const TERMINAL = /^Terminal de cargas (.{1,80}?)\/([A-Z]{2}) - [A-Z0-9]{3}$/;
const BLOCKED = /<title>\s*(?:Access Denied|Request Rejected|403 Forbidden)\s*<\/title>|errors\.edgesuite\.net/i;

/**
 * An AWB of eight digits, or eleven. The tracker's own form splits a pasted
 * 577 prefix (Azul's IATA airline code) off the eight-digit serial.
 */
export function normalizeAzulCargoNumber(raw: string): string {
  const number = raw.length <= 40 ? raw.replace(/[\s.-]/g, '') : '';
  if (/^577\d{8}$/.test(number)) return number.slice(3);
  if (!/^(?:\d{8}|\d{11})$/.test(number)) throw new InvalidInputError(PROVIDER, 'Azul Cargo Express requires an AWB of eight or eleven digits');
  return number;
}

/** The tracker's own share link, which answers like its form. */
export function azulCargoTrackingUrl(raw: string): string {
  return `https://www.azullogistica.com.br/Rastreio/Rastrear?${new URLSearchParams({ awb: normalizeAzulCargoNumber(raw) })}`;
}

/** The year is the latest that puts the clock no later than the day after the read in Brasília. */
function wallClock(text: string, now: number): string {
  const match = CLOCK.exec(text);
  const month = match ? MONTHS.indexOf(match[2]!.toLowerCase()) + 1 : 0;
  if (!match || !month) throw new SchemaError(PROVIDER, 'Azul Cargo Express returned a scan clock it cannot read');
  const [day, hour, minute] = [match[1], match[3], match[4]].map(Number) as [number, number, number];
  if (hour > 23) throw new SchemaError(PROVIDER, 'Azul Cargo Express returned an invalid scan clock');
  const latest = DateTime.fromMillis(now, { zone: AZUL_CARGO_ZONE }).plus({ days: 1 });
  for (let year = latest.year; year >= latest.year - YEARS_BACK; year -= 1) {
    const wall = firstOccurrence(DateTime.fromObject({ year, month, day, hour, minute }, { zone: AZUL_CARGO_ZONE }));
    if (wall.isValid && wall.toMillis() <= latest.toMillis()) return wall.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  }
  throw new SchemaError(PROVIDER, 'Azul Cargo Express returned an invalid scan clock');
}

/** "Terminal de cargas Campo Grande/MS - CGR" names the terminal's town and state. */
function terminalPlace(text: string): string {
  const match = TERMINAL.exec(text);
  return match ? `${match[1]!.trim()}, ${match[2]}` : '';
}

function field(card: Cheerio<AnyNode>, $: CheerioAPI, label: string): string {
  const row = card.find('.rodape .grupo').filter((_index, element) => clean($(element).children('.labelDados').text()) === label);
  return row.length ? clean(row.first().children('.dados').text(), 120) : '';
}

/** The share link's server-rendered page: one card per requested AWB, its full history kept hidden. */
export function parseAzulCargo(html: string, raw: string, now = Date.now()): CarrierResult {
  const number = normalizeAzulCargoNumber(raw);
  if (html.length > AZUL_CARGO_MAX_BYTES) throw new SchemaError(PROVIDER, 'Azul Cargo Express returned an oversized page');
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'Azul Cargo Express refused the tracking page');
  const $ = load(html);
  const cards = $('.cardRastreio');
  // "Nenhum rastreio encontrado para o(s) seguinte(s) Código(s): " and the codes in bold.
  const notice = $('.mensagem').filter((_index, element) => clean($(element).children('span').text()).startsWith('Nenhum rastreio encontrado'));
  const missing = clean(notice.first().children('strong').text(), 400).split(',').map(code => code.trim());
  if (!cards.length) {
    if (missing.includes(number)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Azul Cargo Express returned no tracking result');
  }
  const card = cards.filter((_index, element) => $(element).attr('id') === number);
  if (cards.length !== 1 || card.length !== 1) throw new IndeterminateError(PROVIDER, 'Azul Cargo Express answered for another AWB');
  const rows = card.find('.detalhado .detalhadoNormal .cardDetalhado').not('.titulo');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Azul Cargo Express returned too many scans');
  const events: CarrierEvent[] = [];
  let signedBy = '';
  rows.each((_index, element) => {
    const row = $(element);
    const clock = wallClock(clean(row.children('.dataStatus').find('p').first().text(), 60), now);
    const title = clean(row.find('.tituloDescricao').first().text(), 300);
    // A scan's terminal follows its wording after a comma, or stands on its own line.
    const [, wording = title, after = ''] = /^(.*?)\s*,\s*(Terminal de cargas .*)$/.exec(title) ?? [];
    let location = terminalPlace(after);
    let receiver = '';
    row.find('.descricaoStatus > p').not('.tituloDescricao, .d-block').each((_line, line) => {
      const text = clean($(line).text(), 200);
      location ||= terminalPlace(text);
      receiver = /^Recebido por:\s*(.{1,120})$/.exec(text)?.[1]?.trim() ?? receiver;
    });
    if (!wording) throw new SchemaError(PROVIDER, 'Azul Cargo Express returned a scan without wording');
    const classified = azulCargoStage(wording);
    if (receiver && classified?.stage === 'delivered' && !signedBy) signedBy = receiver;
    events.push({ local_time: clock, description: wording, ...(location ? { location } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) });
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The page lists the newest first; equal clocks keep that order.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const wording = field(card, $, 'Último Status');
  const newest = events[0]!;
  const current: ClassifiedWording | null = (wording ? azulCargoStage(wording) : null)
    ?? (newest.stage ? { stage: newest.stage as Stage, source: newest.stage_source as ClassifiedWording['source'] } : null);
  const finished = current?.stage === 'delivered' || current?.stage === 'returned';
  const forecast = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(clean(card.find('.header .previsaoEntrega span').first().text(), 20));
  const due = forecast && DateTime.fromObject({ year: Number(forecast[3]), month: Number(forecast[2]), day: Number(forecast[1]) }, { zone: 'UTC' });
  const service = clean(card.find('.header .tipoEntrega span').first().text(), 60);
  const weight = /^\d{1,6}(?:,\d{1,3})?$/.test(field(card, $, 'Peso (Kg)')) ? Number(field(card, $, 'Peso (Kg)').replace(',', '.')) : null;
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: wording || events[0]!.description!, last_update: null, last_update_local: events[0]!.local_time!,
    expected_delivery: !finished && due?.isValid ? due.toISODate() : null,
    ...(service ? { service_name: service } : {}),
    ...(weight !== null && weight > 0 ? { weight_kg: weight } : {}),
    ...(signedBy ? { signed_by: signedBy } : {}),
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
