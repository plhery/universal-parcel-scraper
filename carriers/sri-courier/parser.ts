import { load } from 'cheerio';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stages } from './status.js';

export const provider = 'sri-courier';

export function parseTracking(body: string, number: string): CarrierResult {
  const $ = load(body);
  if (clean($('title').first().text()) !== 'Track Parcel | SriCourier'
    || !$('form[method="GET"] input[name="tracking_no"]').length) {
    throw new SchemaError(provider, 'SriCourier did not return its public tracking page');
  }
  const identifier = $('p').filter((_, element) => clean($(element).text()) === 'Tracking No').first();
  if (!identifier.length) throw new NotFoundError(provider);
  if (clean(identifier.next('p').text()).toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'SriCourier did not return the requested parcel');
  }
  const summary = identifier.parent().parent().find('p')
    .filter((_, element) => clean($(element).text()) === 'Status').first();
  const statusText = clean(summary.next('span').text());
  const stage = stages.get(statusText);
  if (!stage) {
    throw new IndeterminateError(provider, 'SriCourier listed the parcel without a recognized current status', { reason: 'listed' });
  }

  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: 'carrier_map',
    last_status_text: statusText,
    summary_only: true,
  };
}
