import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { summaryStages } from './status.js';

export const provider = 'sendbox-argentina';
export const portal = 'https://www.sendbox.com.ar/seguimiento/';
export const endpoint = 'https://www.sendbox.com.ar/wp-admin/admin-ajax.php';

function checkChallenge(body: string): void {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'SendBox requires verification');
  }
}

function readJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'SendBox returned invalid tracking JSON');
  }
}

export function parseFormState(body: string): string {
  checkChallenge(body);
  const $ = load(body);
  const form = $('form#form-bfg').has('#vPrefijoGuia').has('#vNroGuia');
  if (form.find('iframe[src*="captcha"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]').length) {
    throw new ChallengeError(provider, 'SendBox requires verification');
  }
  const source = /\bvar SBX_SEG\s*=\s*(\{[^{}]+\})\s*;/.exec(body)?.[1];
  if (form.length !== 1 || !source) throw new SchemaError(provider, 'SendBox omitted its guest guide form');
  const config = readJson(source);
  if (!isRecord(config) || config.ajaxUrl !== endpoint || typeof config.nonce !== 'string' || !/^[a-f0-9]{10}$/i.test(config.nonce)) {
    throw new SchemaError(provider, 'SendBox omitted the guest form state');
  }
  return config.nonce;
}

export function parseTracking(body: string): CarrierResult {
  checkChallenge(body);
  const reply = readJson(body);
  if (!isRecord(reply)) throw new SchemaError(provider, 'SendBox omitted the guide result');
  if (reply.error === '2' && reply.guia_fecha === '0000-00-00') throw new NotFoundError(provider);
  if (reply.error !== '0') throw new SchemaError(provider, 'SendBox did not return a successful guide lookup');

  const day = clean(reply.guia_fecha).split('T')[0] ?? '';
  const status = clean(reply.estado_nombre);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !DateTime.fromISO(day).isValid || !status || hasPrivateDeliveryDetails(status)) {
    throw new IndeterminateError(provider, 'SendBox listed the guide without a readable dated summary', { reason: 'listed' });
  }
  const stage = summaryStages.get(status.toLowerCase());
  // guia_fecha dates the guide. The reply supplies no scan or delivery clock.
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: status, summary_only: true, events: [],
  };
}
