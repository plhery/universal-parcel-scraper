import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { scanStage } from './status.js';

export const provider = 'litegua-cargo';

export function parseTracking(html: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(html)) {
    throw new ChallengeError(provider, 'Litegua Express requires verification');
  }
  const $ = load(html);
  const headings = $('h1').filter((_, heading) => /^GUIA No\./i.test(clean($(heading).text())));
  const history = $('h5').filter((_, heading) => clean($(heading).text()).toUpperCase() === 'HISTORIAL').closest('table');
  if (headings.length !== 1 || history.length !== 1) {
    throw new SchemaError(provider, 'Litegua Express did not return its electronic guide and history');
  }
  const columns = history.find('tr.trtabla2').eq(1).children('td').map((_, cell) => clean($(cell).text())).get();
  if (columns.join('|') !== 'Fecha|Hora|Estado|Agencia') {
    throw new SchemaError(provider, 'Litegua Express returned unexpected history columns');
  }
  const heading = clean(headings.text());
  const rows = history.find('tr.tr2tabla2').toArray();
  if (/^GUIA No\.$/i.test(heading) && !rows.length) throw new NotFoundError(provider);
  if (heading.match(/^GUIA No\. (\d+)$/i)?.[1] !== number) {
    throw new IndeterminateError(provider, 'Litegua Express did not confirm the full guide number');
  }
  const events = rows.map(row => {
    const cells = $(row).children('td').map((_, cell) => clean($(cell).text())).get();
    const [day, clock, description, location] = cells;
    const time = DateTime.fromFormat(`${day} ${clock}`, 'dd-MM-yyyy HH:mm:ss', { zone: 'utc' });
    if (cells.length !== 4 || !description || !time.isValid) {
      throw new SchemaError(provider, 'Litegua Express returned an invalid history row');
    }
    const stage = scanStage(description);
    return {
      local_time: time.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).reverse().sort((first, second) => second.local_time.localeCompare(first.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Litegua Express listed the guide without dated movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
