import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { guideStages } from './status.js';

export const provider = 'conexiones-empresariales';

export function parseTracking(body: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)|verify (?:that )?you are human|class=["'][^"']*\bg-recaptcha\b/i.test(body)) {
    throw new ChallengeError(provider, 'Conexiones Empresariales requires verification');
  }
  const $ = load(body);
  const tables = $('table.tg');
  if (!tables.length) throw new SchemaError(provider, 'Conexiones Empresariales omitted the guide table');
  if (tables.length !== 1) throw new IndeterminateError(provider, 'Conexiones Empresariales returned more than one guide');

  const fields = new Map<string, string>();
  tables.find('tr').each((_, row) => {
    const cells = $(row).children('td,th');
    const name = clean(cells.first().text()).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    if (['guia', 'fecha de entrega o devolucion', 'ciudad destino'].includes(name)) fields.set(name, clean(cells.eq(1).text()));
  });
  const [matched, description] = fields.get('guia')?.match(/^(\d+) ([\p{L}\p{M} -]+)$/u)?.slice(1) ?? [];
  if (matched !== number || !description) {
    throw new IndeterminateError(provider, 'Conexiones Empresariales did not confirm the exact guide and status');
  }

  const stage = guideStages.get(description.toUpperCase());
  const clock = fields.get('fecha de entrega o devolucion');
  const time = clock ? DateTime.fromFormat(clock, 'd/M/yyyy', { zone: 'utc' }) : null;
  if (time && !time.isValid) throw new SchemaError(provider, 'Conexiones Empresariales returned an invalid outcome date');
  const date = time?.toISODate();
  const city = fields.get('ciudad destino');
  const location = stage === 'delivered' && city && /^[\p{L}\p{M} .'-]{1,80}$/u.test(city) ? city : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: description,
    ...(date && {
      last_update_local: date,
      events: [{
        local_time: date, description, ...(location && { location }),
        ...(stage && { stage, stage_source: 'carrier_map' }),
      }],
    }),
  };
}
