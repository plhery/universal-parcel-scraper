import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, trackingLanguageStage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stageForCode } from './status.js';

export const provider = 'courierit-nz';
export const referencePattern = /^\d{12}$/;

function readHtml(html: string) {
  const $ = load(html);
  if (/^(?:Just a moment|Access Denied|Verification required)/i.test(clean($('title').text()))
    || $('form#challenge-form, .g-recaptcha, iframe[src*="recaptcha"]').length) {
    throw new ChallengeError(provider, 'Courierit returned a verification page');
  }
  return $;
}

export function verifyBooking(html: string, reference: string): void {
  const $ = readHtml(html);
  const headings = $('h2').toArray().map(heading => clean($(heading).text()))
    .filter(heading => /^Consignment\s/i.test(heading));
  if (headings.length !== 1) throw new SchemaError(provider, 'Courierit omitted a unique consignment heading');
  if (headings[0] !== `Consignment ${reference}`) {
    throw new IndeterminateError(provider, 'Courierit returned a different consignment');
  }
}

function parseEvent(code: string, text: string): CarrierEvent | undefined {
  if (!code) return undefined;
  const clock = /\b\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}\b/.exec(text)?.[0];
  const date = clock ? DateTime.fromFormat(clock, 'dd/MM/yyyy HH:mm:ss', { zone: 'UTC' }) : undefined;
  const mapped = stageForCode(code);
  const stage = mapped ?? trackingLanguageStage(code);
  return {
    description: code, provider_code: code,
    ...(date?.isValid ? { local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss") } : {}),
    ...(stage ? { stage, stage_source: mapped ? 'carrier_map' : 'wording:language' } : {}),
  };
}

export function parseStatus(html: string): CarrierResult {
  const $ = readHtml(html);
  const sections = $('.detail-wrapper').toArray();
  const summarySection = sections.find(section => clean($(section).children('label').text()) === 'Status');
  const historySection = sections.find(section => clean($(section).children('label').text()) === 'Consignment History');
  if (!summarySection || !historySection) throw new SchemaError(provider, 'Courierit changed its status and history sections');

  const summaryRow = $(summarySection).children('.order-detail-field');
  const summary = parseEvent(clean(summaryRow.children('span').first().text(), 100), summaryRow.text());
  const history = $(historySection).find('.consignment-status').toArray().flatMap(row => {
    const event = parseEvent(clean($(row).children('span').first().text(), 100), $(row).text());
    return event ? [event] : [];
  });
  const events = [...(summary?.local_time ? [summary] : []), ...history]
    .sort((left, right) => (right.local_time ?? '').localeCompare(left.local_time ?? ''));
  if (!summary && events.length === 0) throw new NoHistoryError(provider);
  const latest = summary ?? events[0]!;
  const stage = stageForCode(latest.provider_code ?? '') ?? trackingLanguageStage(latest.description ?? '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    provider_code: latest.provider_code,
    last_status_text: latest.description ?? null,
    last_update: null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    ...(events.length === 0 ? { summary_only: true } : {}),
    events,
  };
}
