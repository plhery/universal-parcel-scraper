import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { swiftDropStage } from './status.js';

const carrier = 'swift-drop-ae';

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Swift Drop returned a browser check');
  }

  const $ = load(html);
  const title = clean($('title').text());
  const heading = $('h1');
  if (heading.length !== 1 || !/^Tracking .+ \| Swift Drop$/.test(title)) {
    throw new SchemaError(carrier, 'Swift Drop changed its tracking page');
  }

  const statusText = clean(heading.text());
  if (statusText === 'We couldn’t find that order') {
    const notice = clean(heading.next('p').text());
    if (notice === `No order matches “${number}”. Check the number in your confirmation message.`) {
      throw new NotFoundError(carrier);
    }
    throw new IndeterminateError(carrier, 'Swift Drop returned an unbound missing-order message');
  }

  const orderLabel = clean(heading.prev('p').text());
  const isPublishedDemo = number === 'SD-DEMO' && orderLabel === 'Order SD-DEMO · demo';
  if (orderLabel !== `Order ${number}` && !isPublishedDemo) {
    throw new IndeterminateError(carrier, 'Swift Drop did not repeat the requested order number');
  }
  if (!statusText) throw new SchemaError(carrier, 'Swift Drop did not return an order status');

  const stage = swiftDropStage(statusText);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: statusText,
    last_update: null,
    expected_delivery: null,
    summary_only: true,
    events: [],
  };
}
