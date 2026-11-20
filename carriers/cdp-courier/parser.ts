import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'cdp-courier';
export const endpoint = 'https://cdpcourier.com/wp-admin/admin-ajax.php';

function checkChallenge(body: string): void {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'CDP Courier requires verification');
  }
}

function readJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    throw new SchemaError(provider, 'CDP Courier changed its tracking response');
  }
}

export function parseFormState(body: string): string {
  checkChallenge(body);
  const $ = load(body);
  const form = $('.tracking-container form').has('input#tracking_id');
  if (form.length === 1 && form.find('iframe[src*="captcha"], .g-recaptcha, .h-captcha, .cf-turnstile').length > 0) {
    throw new ChallengeError(provider, 'CDP Courier requires verification');
  }
  const state = $('script#my-ajax-handle-js-extra').text().match(/\bvar my_ajax_obj\s*=\s*(\{[^{}]+\})\s*;/)?.[1];
  if (form.length !== 1 || !state) throw new SchemaError(provider, 'CDP Courier omitted its guest search form');
  const config = readJson(state);
  if (!isRecord(config) || config.ajax_url !== endpoint || typeof config.nonce !== 'string' || !/^[a-f0-9]{10}$/i.test(config.nonce)) {
    throw new SchemaError(provider, 'CDP Courier omitted its guest form state');
  }
  return config.nonce;
}

export function parseTracking(body: string): CarrierResult {
  checkChallenge(body);
  const reply = readJson(body);
  if (!isRecord(reply) || reply.success !== true || !isRecord(reply.data) || typeof reply.data.message !== 'string') {
    throw new SchemaError(provider, 'CDP Courier did not return a successful guest tracking search');
  }

  const $ = load(reply.data.message);
  $('script, style').remove();
  $('br').replaceWith('\n');
  const text = $('body').text().trim();
  if (!text) throw new NotFoundError(provider);

  const events = text.split(/_{8,}/).map(row => row.trim()).filter(Boolean).map(row => {
    const clock = /^Update:\s*([^\r\n]+)$/m.exec(row)?.[1]?.trim();
    const description = /^\s*Status:\s*([^\r\n]+)$/m.exec(row)?.[1]?.trim();
    const location = /^\s*Location:[ \t]*([^\r\n]+)$/m.exec(row)?.[1]?.trim();
    const date = clock && DateTime.fromFormat(clock, 'yyyy/MM/dd hh:mm:ss a', { locale: 'en', zone: 'utc' });
    if (!date || !date.isValid || !description) throw new SchemaError(provider, 'CDP Courier returned an invalid tracking event');
    const stage = scanStage(description);
    return {
      local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description,
      ...(location && { location }), ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new SchemaError(provider, 'CDP Courier omitted its tracking events');
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
