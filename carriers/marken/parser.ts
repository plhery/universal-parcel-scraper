import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, trackingLanguageStage, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stageForWording } from './status.js';

export const provider = 'marken';
export const referencePattern = /^[A-Z0-9]{6,20}$/;

function clockOf(value: string): string | undefined {
  const parsed = DateTime.fromFormat(value.replace(/\bSEPT\b/i, 'SEP'), "yyyy MMM d 'AT' HH:mm", {
    locale: 'en', zone: 'UTC',
  });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

function eventOf(wording: string, rawClock: string): CarrierEvent & { stage?: Stage } {
  const clock = clockOf(rawClock);
  const mapped = stageForWording(wording);
  const stage = mapped ?? trackingLanguageStage(wording);
  return {
    ...(wording ? { description: wording, provider_code: wording } : {}),
    ...(clock ? { local_time: clock } : {}),
    ...(stage ? { stage, stage_source: mapped ? 'carrier_map' : 'wording:language' } : {}),
  };
}

export function parseTracking(html: string, reference: string): CarrierResult {
  const $ = load(html);
  if (/^(?:Just a moment|Access Denied|Verification required)/i.test(clean($('title').text()))
    || $('form#challenge-form').length) {
    throw new ChallengeError(provider, 'Marken returned a verification page');
  }
  const field = $('form input#jobNumber[name="jobNumber"]');
  if (field.length !== 1) throw new SchemaError(provider, 'Marken omitted its job tracking form');
  if (clean(field.attr('value')).toUpperCase() !== reference) {
    throw new IndeterminateError(provider, 'Marken echoed a different job reference');
  }
  const wrapper = field.closest('form').siblings('div.mt-4');
  const panel = wrapper.children('div.border-t');
  if (panel.length === 0 && /(?:no (?:shipment|result|record)|not found|could not find)/i.test(clean(wrapper.text()))) {
    throw new NotFoundError(provider);
  }
  const fields = panel.children('dl').children('dt').toArray();
  const values = new Map(fields.flatMap<[string, string]>((term, index) =>
    index % 2 === 0 && fields[index + 1] ? [[clean($(term).text()), clean($(fields[index + 1]).text())]] : []));
  if (panel.length !== 1 || !values.has('Tracking ID')) {
    throw new SchemaError(provider, 'Marken omitted the tracked shipment panel');
  }
  if (values.get('Tracking ID')?.toUpperCase() !== reference) {
    throw new IndeterminateError(provider, 'Marken returned a different shipment');
  }
  const events = panel.children('ul').children('li').toArray().flatMap(row => {
    const spans = $(row).children('div').children('span.block');
    const wording = clean(spans.eq(-2).text(), 150);
    const rawClock = clean(spans.last().text(), 70);
    return wording && !hasPrivateDeliveryDetails(wording) && rawClock ? [eventOf(wording, rawClock)] : [];
  }).reverse();

  const summary = panel.children('div').first().children('p');
  const rawStatus = clean(summary.first().text(), 170);
  const wording = /^Delivered\s+at\b/i.test(rawStatus) ? 'Delivered'
    : hasPrivateDeliveryDetails(rawStatus) ? '' : rawStatus;
  const current = wording ? eventOf(wording, clean(summary.eq(1).text(), 70)) : events[0];
  if (!current) throw new NoHistoryError(provider);

  const weight = /^(\d+(?:[.,]\d+)?)\s*kg$/i.exec(values.get('Weight') ?? '');
  const staged = current.stage ? current : events.find(event => event.stage);
  const stage = staged?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged?.stage_source } : {}),
    ...(current.provider_code ? { provider_code: current.provider_code } : {}),
    last_status_text: current.description ?? null,
    last_update: null,
    ...(current.local_time ? { last_update_local: current.local_time } : {}),
    ...(weight ? { weight_kg: Number(weight[1]!.replace(',', '.')) } : {}),
    ...(events.length === 0 ? { summary_only: true } : {}),
    events,
  };
}
