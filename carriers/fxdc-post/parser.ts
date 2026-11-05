import { load } from 'cheerio';
import { isFxdcPostReference } from '../../core/detection/fxdcPost.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { fxdcPostStage } from './status.js';

export const PROVIDER = 'FXDC Post';
export function normalizeFxdcPostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'FXDC Post needs a parcel reference');
  if (!isFxdcPostReference(number)) throw new NoHistoryError(PROVIDER, 'The verified guest route supports forwarding references', { reason: 'unsupported_reference' });
  return number;
}
export function fxdcPostUrl(number: string): string { return `https://my.fxdc-post.com/klant/volgen?${new URLSearchParams({ ref: normalizeFxdcPostNumber(number) })}`; }
export function parseFxdcPost(html: string, raw: string): CarrierResult {
  const number = normalizeFxdcPostNumber(raw), $ = load(html); $('script,style,template').remove();
  const input = $('form[action="/klant/volgen"] input[name="ref"]'), results = $('.result');
  if (input.length !== 1 || input.val() !== number) throw new SchemaError(PROVIDER, 'FXDC Post returned another requested reference');
  const absent = /Dit nummer kennen we niet/.test($.root().text());
  if (absent && results.length <= 1 && !results.find('.rnum,.rtop,.rmeta,.rright,.steps').length) throw new NotFoundError(PROVIDER);
  if (absent || results.length !== 1 || results.find('.rnum').length !== 1 || clean(results.find('.rnum').text(), 64) !== number) throw new SchemaError(PROVIDER, 'FXDC Post returned an unbound result');
  if (results.attr('data-svc') !== 'pm' || results.find('.slogo.pm').length !== 1) throw new NoHistoryError(PROVIDER, 'The guest result is outside the verified forwarding service', { reason: 'unsupported_service' });
  const meta = clean(results.find('.rmeta').text(), 600).split('·').map(value => value.trim());
  if (meta.length !== 3 || meta[2] !== 'Punto Mio') throw new SchemaError(PROVIDER, 'FXDC Post changed its forwarding facts');
  const weight = /^(\d+(?:[,.]\d+)?) (lb|kg)$/.exec(meta[1]!);
  if (!weight || Number(weight[1]!.replace(',', '.')) > 1_000_000) throw new SchemaError(PROVIDER, 'FXDC Post returned an invalid mass');
  const steps = results.find('.steps .stp'), current = steps.filter('.now'), heading = results.find('.rright b'), updated = results.find('.rright s');
  if (!steps.length || steps.length > 30 || current.length !== 1 || current.find('h4').length !== 1 || heading.length !== 1 || updated.length !== 1) throw new SchemaError(PROVIDER, 'FXDC Post changed its progress view');
  const description = clean(current.find('h4').text(), 100);
  if (description !== clean(heading.text(), 100) || !description || /[<>@]|\d{6,}/.test(description)) throw new SchemaError(PROVIDER, 'FXDC Post returned contradictory current states');
  const received = steps.filter((_, el) => clean($(el).find('h4').text()) === 'Ontvangen in Miami' && ($(el).hasClass('done') || $(el).hasClass('now')));
  if (description !== 'Aangemeld' && !received.length) throw new NoHistoryError(PROVIDER, 'The portal did not show its own forwarding leg', { reason: 'unsupported_service' });
  const date = /^bijgewerkt (\d{2})-(\d{2})-(\d{4})$/.exec(clean(updated.text(), 80));
  const day = date ? calendarDay(Number(date[3]), Number(date[2]), Number(date[1])) : null;
  if (!day) throw new SchemaError(PROVIDER, 'FXDC Post returned an invalid update day');
  const stage = fxdcPostStage(null, description), mass = Number(weight[1]!.replace(',', '.')) * (weight[2] === 'lb' ? 0.45359237 : 1);
  // The progress diagram has no scan dates. Its update day is not a delivery instant.
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: description, last_update: null, last_update_local: day, expected_delivery: null,
    service_name: 'Punto Mio', weight_kg: mass, summary_only: true, events: [] };
}
