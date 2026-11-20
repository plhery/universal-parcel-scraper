import { load } from 'cheerio';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stages } from './status.js';

export const provider = 'tpl-korea';

export function parseTracking(html: string, number: string): CarrierResult {
  const $ = load(html);
  const heading = $('h4.box-title').filter((_, element) => /^송장번호\s*-\s*[A-Z0-9]+$/i.test(clean($(element).text()))).first();
  if (!heading.length) throw new SchemaError(provider, 'TPL Korea did not return a waybill status panel');
  if (clean(heading.text()).replace(/^송장번호\s*-\s*/, '').toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'TPL Korea returned a different waybill');
  }
  const progress = heading.closest('.box').find('ol.statusbar');
  if (!progress.length) throw new SchemaError(provider, 'TPL Korea omitted its progress bar');
  const description = clean(progress.children('li.is-complete').last().attr('data-step') ?? '');
  if (!description || hasPrivateDeliveryDetails(description)) {
    throw new IndeterminateError(provider, 'TPL Korea listed the waybill without a completed stage', { reason: 'listed' });
  }
  const stage = stages.get(description);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: description, summary_only: true,
  };
}
