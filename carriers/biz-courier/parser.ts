import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { stageForScan } from './status.js';

export const provider = 'biz-courier';

export function parseTracking(html: string, number: string): CarrierResult {
  const $ = load(html);
  const results = $('#voucher_browse_list');
  if (results.length !== 1) {
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(html)) {
      throw new ChallengeError(provider, 'Track iT requires verification');
    }
    throw new SchemaError(provider, 'Missing Track iT results');
  }
  const identities = results.find('td.voucher[title="Tracking Number"]');
  if (!identities.length && $('#r18p01').text().trim() === number &&
    results.find('td.error_title').text().trim().startsWith('No tracking results found,')) {
    throw new NotFoundError(provider);
  }
  const identity = identities.filter((_, element) => $(element).text().trim().toUpperCase() === number);
  if (identity.length !== 1) throw new IndeterminateError(provider, 'Track iT could not identify one matching shipment');
  const summary = identity.closest('tr');
  const rows = summary.next('tr.vchHistData').find('section.v-timeline__section:not(.v-timeline__section-secondary)');
  const scans = rows.toArray().map(row => {
    const description = $(row).find('.text-component h3').text().trim();
    const clock = explicitOffsetTime($(row).find('time.v-timeline__date-value').attr('datetime'));
    if (!description || !clock) throw new SchemaError(provider, 'Invalid Track iT history row');
    const comment = $(row).find('.text-comments').text().trim();
    const code = /^([A-Z0-9]+)#/.exec(comment)?.[1] ?? null;
    const stage = stageForScan(code, normalizeStatusWording(description));
    const event: CarrierEvent = {
      description, time: clock.iso,
      ...(code ? { provider_code: code } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return { event, stage, timestamp: clock.timestamp };
  }).sort((a, b) => b.timestamp - a.timestamp);
  const summaryText = summary.find('td[title="Status"]').text().trim();
  const summaryClock = explicitOffsetTime(summary.find('td[title="Time"]').attr('data-timestamp'));
  if (!scans.length && (!summaryText || !summaryClock)) throw new NoHistoryError(provider);
  const useSummary = summaryText && summaryClock && (!scans.length || summaryClock.timestamp > scans[0]!.timestamp);
  const newest = useSummary ? { description: summaryText, time: summaryClock.iso } : scans[0]!.event;
  const stage = (useSummary ? stageForScan(null, normalizeStatusWording(summaryText)) : undefined) ??
    scans.find(row => row.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: newest.time,
    events: [...(useSummary ? [newest] : []), ...scans.map(row => row.event)],
  };
}
