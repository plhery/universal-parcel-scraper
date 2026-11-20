import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statuses } from './status.js';

export const provider = 'hulak-logistics';

function dateOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clock = DateTime.fromFormat(clean(value), 'd LLL yyyy, h:mm a', { locale: 'en-US', zone: 'UTC' });
  return clock.isValid ? clock.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

function statusOf(value: unknown) {
  return typeof value === 'string' ? statuses.get(clean(value).toLowerCase()) : undefined;
}

export function parseTracking(body: string, number: string): CarrierResult {
  const $ = load(body);
  if ($('input[name="captcha_code"], .h-captcha, .g-recaptcha, .cf-turnstile').length) {
    throw new ChallengeError(provider, 'Hulak Logistics requires verification');
  }
  if (clean($('title').first().text()) !== 'Track Your Shipment | Hulak Logistics Nepal'
    || !$('form input[name="tracking_number"]').length) {
    throw new SchemaError(provider, 'Hulak Logistics did not return its tracking portal');
  }
  const script = $('script#trackBootstrap[type="application/json"]').first().text();
  if (!script) throw new NotFoundError(provider);
  let data: unknown;
  try {
    data = JSON.parse(script);
  } catch {
    throw new SchemaError(provider, 'Hulak Logistics returned invalid shipment data');
  }
  if (!isRecord(data) || data.reference_id !== number) {
    throw new IndeterminateError(provider, 'Hulak Logistics did not return the requested reference');
  }

  const explicit: unknown[] = Array.isArray(data.history) ? data.history : [];
  const timeline: unknown[] = Array.isArray(data.timeline) ? data.timeline.filter(
    (row: unknown) => isRecord(row) && (row.state === 'is-done' || row.state === 'is-current'),
  ) : [];
  const movements = new Map<string, CarrierEvent & { stage: Stage }>();
  for (const value of [...explicit, ...timeline]) {
    if (!isRecord(value)) continue;
    const wording = statusOf(value.label);
    const localTime = dateOf(value.time);
    if (wording && localTime) {
      movements.set(JSON.stringify([wording.label, localTime]), {
        local_time: localTime, description: wording.label, stage: wording.stage, stage_source: 'carrier_map',
      });
    }
  }
  const history = [...movements.values()].sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const summary = statusOf(data.status) ?? statusOf(data.status_label);
  const latest = history[0];
  const stage = summary?.stage ?? latest?.stage;
  if (!stage) {
    throw new IndeterminateError(provider, 'Hulak Logistics listed the reference without a usable status', { reason: 'listed' });
  }
  const updated = dateOf(data.last_update) ?? (summary ? history.find(event => event.stage === stage) : latest)?.local_time;
  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: 'carrier_map',
    last_status_text: summary?.label ?? latest?.description,
    ...(updated && { last_update_local: updated }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
