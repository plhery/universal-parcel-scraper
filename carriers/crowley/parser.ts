import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanStages } from './status.js';

export const provider = 'crowley';
const application = 'siteforce:communityApp';
const applicationKey = 'APPLICATION@markup://siteforce:communityApp';

function checkChallenge(body: string) {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)|verify (?:that )?you are human/i.test(body)) {
    throw new ChallengeError(provider, 'Crowley requires verification');
  }
}

export function guestContext(html: string): string {
  checkChallenge(html);
  const encoded = html.match(/\/s\/sfsites\/l\/([^/\s"'<>]+)\/bootstrap\.js/)?.[1];
  let page: unknown;
  try {
    page = encoded && JSON.parse(decodeURIComponent(encoded));
  } catch {
    throw new SchemaError(provider, 'Crowley returned an invalid guest bootstrap');
  }
  if (!isRecord(page) || page.app !== application || page.mode !== 'PROD' || typeof page.fwuid !== 'string'
      || !isRecord(page.loaded) || typeof page.loaded[applicationKey] !== 'string') {
    throw new SchemaError(provider, 'Crowley omitted its guest framework context');
  }
  return JSON.stringify({
    mode: page.mode, app: application, fwuid: page.fwuid, loaded: { [applicationKey]: page.loaded[applicationKey] },
    dn: [], globals: {}, uad: true,
  });
}

function actionValue(body: string) {
  checkChallenge(body);
  let response: unknown;
  try {
    response = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Crowley did not return tracking JSON');
  }
  const actions = isRecord(response) ? response.actions : null;
  const action: unknown = Array.isArray(actions) && actions.length === 1 ? actions[0] : null;
  const wrapper = isRecord(action) && action.state === 'SUCCESS' ? action.returnValue : null;
  const value = isRecord(wrapper) ? wrapper.returnValue : null;
  if (!isRecord(value)) throw new SchemaError(provider, 'Crowley omitted its guest tracking response');
  return value;
}

export function parseCount(body: string): number {
  const value = actionValue(body);
  if (typeof value.Data !== 'number' || !Number.isSafeInteger(value.Data) || value.Data < 0) {
    throw new SchemaError(provider, 'Crowley omitted its movement count');
  }
  if (value.Data === 0 && value.countOfErroredEvents !== 0) {
    throw new IndeterminateError(provider, 'Crowley could not retrieve the bill’s movements');
  }
  return value.Data;
}

export function parseMovements(body: string) {
  const buckets = actionValue(body).equipNumVsListOfEventsMap;
  if (!isRecord(buckets) || Object.keys(buckets).length === 0) {
    throw new IndeterminateError(provider, 'Crowley listed the bill without an equipment history', { reason: 'listed' });
  }
  return Object.values(buckets).flatMap(rows => {
    if (!Array.isArray(rows)) throw new SchemaError(provider, 'Crowley returned an invalid equipment history');
    return rows.map((row: unknown) => {
      const wording = isRecord(row) ? row['EVENT TYPE'] : null;
      const clock = isRecord(row) ? row['EVENT DATE & TIME (LOCAL TIME)'] : null;
      const location = isRecord(row) ? row.LOCATION : null;
      if (typeof wording !== 'string' || !wording.trim() || typeof clock !== 'string' || typeof location !== 'string') {
        throw new SchemaError(provider, 'Crowley returned an invalid shipment movement');
      }
      const description = wording.trim();
      const time = DateTime.fromFormat(clock.trim(), 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
      if (!time.isValid) throw new SchemaError(provider, 'Crowley returned an invalid movement time');
      const code = description.match(/\(([A-Z0-9]+)\)$/)?.[1] ?? description;
      const stage = scanStages.get(code);
      return {
        local_time: time.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description, provider_code: code,
        ...(location.trim() && { location: location.trim() }),
        ...(stage && { stage, stage_source: 'carrier_map' as const }),
      };
    });
  });
}

export function trackingResult(movements: ReturnType<typeof parseMovements>): CarrierResult {
  const unique = new Map(movements.map(event => [
    JSON.stringify([event.description, event.local_time, event.location]), event,
  ]));
  const events = [...unique.values()].sort((a, b) => b.local_time.localeCompare(a.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Crowley listed the bill without dated movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
