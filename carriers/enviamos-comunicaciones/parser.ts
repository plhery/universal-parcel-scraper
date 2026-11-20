import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { summaryStages } from './status.js';

export const provider = 'enviamos-comunicaciones';

function localDate(value: string): string | undefined {
  const date = DateTime.fromFormat(value, 'd LLL yyyy', { locale: 'en-US', zone: 'utc' });
  return date.isValid ? date.toISODate() : undefined;
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Enviamos requires verification');
  }
  const $ = load(body);
  const content = $('.main-content .section-content');
  const missing = content.children('h4').filter((_, heading) =>
    clean($(heading).text()).startsWith('No existe ningún envío con el número de envío '));
  if (missing.length) {
    if (missing.length === 1 && clean(missing.children('span.color-rojo').text()).toUpperCase() === number.toUpperCase()) {
      throw new NotFoundError(provider);
    }
    throw new IndeterminateError(provider, 'Enviamos answered for a different guide');
  }
  const details = content.children('.text-left').filter((_, element) =>
    $(element).find('h3 > span.color-rojo').length === 1);
  if (details.length !== 1) throw new SchemaError(provider, 'Enviamos omitted its shipment details');
  const field = (label: string) => clean(details.children('.row').children('.col-sm-4')
    .filter((_, element) => clean($(element).text()) === label).next('.col-sm-8').text());
  const titleGuide = clean(details.find('h3 > span.color-rojo').text()).toUpperCase();
  if (titleGuide !== number.toUpperCase() || field('Código').toUpperCase() !== titleGuide) {
    throw new IndeterminateError(provider, 'Enviamos returned a different guide');
  }
  const status = field('Estado actual');
  const stage = summaryStages.get(status);
  const visit = localDate(field('Fecha última visita'));
  const intake = localDate(field('Fecha ingreso oficina'));
  const events: CarrierEvent[] = [];
  if (visit) events.push({ local_time: visit, description: 'Fecha última visita' });
  if (intake) events.push({
    local_time: intake, description: 'Fecha ingreso oficina', stage: 'accepted', stage_source: 'carrier_map',
  });
  events.sort((first, second) => (second.local_time ?? '').localeCompare(first.local_time ?? ''));
  if (!stage && !events.length) {
    throw new IndeterminateError(provider, 'Enviamos listed the shipment without a known outcome or dated movements', { reason: 'listed' });
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map', last_status_text: status }),
    ...(events.length ? { events } : { summary_only: true }),
  };
}
