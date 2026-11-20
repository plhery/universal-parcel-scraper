import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { dJesuComerStage } from './status.js';

const carrier = 'd-jesu-comer';

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'D’Jesu COMER returned a browser check');
  }
  const $ = load(html);
  const container = $('main .rastreo-container');
  if (container.length !== 1) throw new SchemaError(carrier, 'D’Jesu COMER changed its tracking page');
  const missing = container.find('.rastreo-not-found h3');
  if (missing.length === 1 && clean(missing.text()) === 'Orden no encontrada') throw new NotFoundError(carrier);

  const panel = container.children('.rastreo-timeline');
  const code = panel.find('.rastreo-header .orden-codigo');
  if (panel.length !== 1 || code.length !== 1) throw new SchemaError(carrier, 'D’Jesu COMER changed its guide header');
  if (clean(code.text()) !== 'Orden: ' + number) throw new IndeterminateError(carrier, 'D’Jesu COMER returned a different guide');

  const created = panel.find('.rastreo-header .orden-fecha');
  const date = /^Creada: (\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(clean(created.text()));
  const day = date && calendarDay(Number(date[3]), Number(date[2]), Number(date[1]));
  if (created.length !== 1 || !day) throw new SchemaError(carrier, 'D’Jesu COMER returned an invalid creation date');

  const timeline = panel.children('.timeline-container');
  const steps = timeline.children('.timeline-step');
  const current = steps.filter('.current');
  if (timeline.length !== 1 || !steps.length || steps.length > 40 || current.length !== 1 || !current.hasClass('completed')) {
    throw new SchemaError(carrier, 'D’Jesu COMER changed its tracking steps');
  }
  const currentText = clean(current.find('.step-title').text(), 120);
  const currentStage = dJesuComerStage(currentText);
  const events = steps.filter('.completed').toArray().reverse().map((row): CarrierEvent => {
    const step = $(row);
    const title = step.find('.step-title');
    const description = clean(title.text(), 120);
    if (title.length !== 1 || !description) throw new SchemaError(carrier, 'D’Jesu COMER changed its step labels');
    const stage = dJesuComerStage(description);
    return {
      description,
      ...(stage === 'registered' && { local_time: day }),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    };
  });

  return {
    status: currentStage ? languageStageStatus(currentStage) : 'unknown',
    ...(currentStage && { current_stage: currentStage, current_stage_source: 'explicit_mapping' }),
    last_status_text: currentText, last_update: null, expected_delivery: null, events,
    ...(currentStage === 'registered' && { last_update_local: day }),
  };
}
