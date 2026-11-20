import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { paqmexStage } from './status.js';

const carrier = 'paqmex';

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'PaqMex returned a browser check');
  }

  const $ = load(html);
  const results = $('section[aria-label="Resultado"]');
  const article = results.children('article[aria-labelledby="rd-est"]');
  const missing = results.children('section[aria-labelledby="r-no"]').children('h2#r-no');
  if (!article.length && missing.length === 1 && clean(missing.text()) === `No encontramos ${number}`) {
    throw new NotFoundError(carrier);
  }
  if (article.length !== 1 || missing.length) {
    throw new SchemaError(carrier, 'PaqMex changed its guide result');
  }

  const header = article.children('header');
  if (header.length !== 1 || clean(header.children('p').text()) !== `Guía ${number}`) {
    throw new IndeterminateError(carrier, 'PaqMex returned a different guide');
  }
  const headline = clean(header.children('h2#rd-est').text(), 160);
  if (!headline) throw new SchemaError(carrier, 'PaqMex omitted the shipment status');

  // Next.js streams some timeline rows separately. Apply its literal segment links without running scripts.
  for (const script of $('script').toArray()) {
    const link = /(?:^|;)\$RS\("(S:[a-f\d]+)","(P:[a-f\d]+)"\);?$/.exec($(script).text());
    if (!link) continue;
    const [, source, target] = link;
    const segment = $(`div[hidden][id="${source}"]`);
    const placeholder = $(`template[id="${target}"]`);
    if (segment.length === 1 && placeholder.length === 1) {
      placeholder.replaceWith(segment.contents());
      segment.remove();
    }
  }

  const history = article.children('section[aria-labelledby="rd-hist"]');
  const rows = history.children('ol').children('li');
  if (history.length > 1 || history.find('template').length || (history.length && !rows.length) || rows.length > 500) {
    throw new SchemaError(carrier, 'PaqMex returned an incomplete timeline');
  }

  const events = rows.toArray().map((row): CarrierEvent => {
    const contents = $(row).children('span').last();
    const label = contents.children('strong').clone();
    label.children().remove();
    const description = clean(label.text(), 200);
    const location = clean(contents.children('strong').next('span').text(), 160);
    const time = $(row).find('time[datetime]').first().attr('datetime') ?? '';
    if (!description || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(time)
      || !DateTime.fromISO(time, { zone: 'UTC' }).isValid) {
      throw new SchemaError(carrier, 'PaqMex changed its scan fields');
    }
    const stage = paqmexStage(description);
    return {
      local_time: time, description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    };
  });

  const stage = paqmexStage(headline);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: headline, last_update: null, last_update_local: events[0]?.local_time ?? null,
    expected_delivery: null, events: events.slice(0, 100),
    ...(!events.length && { summary_only: true }),
    ...(events.length > 100 && { history_truncated: true }),
  };
}
