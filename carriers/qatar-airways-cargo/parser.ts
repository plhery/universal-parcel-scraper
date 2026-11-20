import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { movementMeaning } from './status.js';

export const provider = 'qatar-airways-cargo';
export const application = 'siteforce:communityApp';
const applicationKey = 'APPLICATION@markup://siteforce:communityApp';

function checkChallenge(body: string) {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)|verify (?:that )?you are human/i.test(body)) {
    throw new ChallengeError(provider, 'Qatar Airways Cargo requires verification');
  }
}

export function guestContext(html: string): string {
  checkChallenge(html);
  const encoded = html.match(/\/s\/sfsites\/l\/([^/\s"'<>]+)\/bootstrap\.js/)?.[1];
  let page: unknown;
  try {
    page = encoded && JSON.parse(decodeURIComponent(encoded));
  } catch {
    throw new SchemaError(provider, 'Qatar Airways Cargo returned an invalid guest bootstrap');
  }
  if (!isRecord(page) || page.app !== application || page.mode !== 'PROD' || typeof page.fwuid !== 'string'
      || !isRecord(page.loaded) || typeof page.loaded[applicationKey] !== 'string') {
    throw new SchemaError(provider, 'Qatar Airways Cargo omitted the guest framework context');
  }
  return JSON.stringify({
    mode: page.mode, app: application, fwuid: page.fwuid, loaded: { [applicationKey]: page.loaded[applicationKey] },
    dn: [], globals: {}, uad: true,
  });
}

export function parseTracking(body: string, serial: string): CarrierResult {
  checkChallenge(body);
  let response: unknown;
  try {
    response = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Qatar Airways Cargo did not return tracking JSON');
  }
  const actions = isRecord(response) ? response.actions : null;
  const action: unknown = Array.isArray(actions) && actions.length === 1 ? actions[0] : null;
  const wrapper = isRecord(action) && action.state === 'SUCCESS' ? action.returnValue : null;
  const value = isRecord(wrapper) ? wrapper.returnValue : null;
  const records = isRecord(value) ? value.cargoTrackingSOs : null;
  if (!Array.isArray(records)) throw new SchemaError(provider, 'Qatar Airways Cargo omitted its tracking list');
  if (!records.length) throw new NotFoundError(provider);
  const record: unknown = records[0];
  if (records.length !== 1 || !isRecord(record) || record.docType !== 'MAWB'
      || record.docPrefix !== '157' || record.docNumber !== serial) {
    throw new IndeterminateError(provider, 'Qatar Airways Cargo did not confirm the full air waybill');
  }
  const history = record.cargoTrackingMvtStausList;
  if (!Array.isArray(history)) throw new SchemaError(provider, 'Qatar Airways Cargo omitted its movement history');

  const seen = new Set<string>();
  const events = history.flatMap(row => {
    if (!isRecord(row) || typeof row.movementStatus !== 'string' || typeof row.eventDate !== 'string'
        || typeof row.eventTime !== 'string' || typeof row.eventAirport !== 'string') {
      throw new SchemaError(provider, 'Qatar Airways Cargo returned an invalid movement');
    }
    const code = row.movementStatus.trim();
    const location = row.eventAirport.trim();
    const time = DateTime.fromFormat(`${row.eventDate.trim()} ${row.eventTime.trim()}`, 'EEE, dd MMM yyyy HH:mm', {
      zone: 'utc', locale: 'en',
    });
    if (!code || !time.isValid) throw new SchemaError(provider, 'Qatar Airways Cargo returned an invalid movement code or time');
    const localTime = time.toFormat("yyyy-MM-dd'T'HH:mm");
    const key = JSON.stringify([code, location, localTime]);
    if (seen.has(key)) return [];
    seen.add(key);
    const meaning = movementMeaning(code);
    return [{
      local_time: localTime, description: meaning?.label ?? code, provider_code: code,
      ...(location && { location }),
      ...(meaning && { stage: meaning.stage, stage_source: 'carrier_map' }),
    }];
  }).sort((first, second) => second.local_time.localeCompare(first.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Qatar Airways Cargo listed the shipment without dated movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
