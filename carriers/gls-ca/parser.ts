import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { glsCanadaNameStage, glsCanadaStage } from './status.js';

export const PROVIDER = 'GLS Canada';

const CLOCK = 'yyyy-MM-dd HH:mm:ss';

export function glsCanadaNumber(raw: string): string {
  const number = raw.length <= 80 ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{1,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'GLS Canada takes one tracking number');
  return number;
}

function wallTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== 19) return undefined;
  const date = DateTime.fromFormat(value, CLOCK, { zone: 'UTC' });
  return date.isValid && date.toFormat(CLOCK) === value ? date.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

function readJson(body: string): unknown {
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required)|cf-chl-|g-recaptcha|cf-turnstile/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'GLS Canada returned a verification page');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new SchemaError(PROVIDER, 'GLS Canada returned invalid tracking JSON');
  }
}

type Scan = CarrierEvent & { local_time: string; description: string; stage?: Stage };

function readScans(parcel: unknown): Scan[] {
  if (!isRecord(parcel)) throw new SchemaError(PROVIDER, 'GLS Canada returned an invalid parcel');
  const activities = parcel.activities ?? [];
  if (!Array.isArray(activities) || activities.length > 500) throw new SchemaError(PROVIDER, 'GLS Canada returned an invalid activity list');
  return activities.map((activity: unknown) => {
    if (!isRecord(activity) || activity.parcelId !== parcel.parcelId) {
      throw new SchemaError(PROVIDER, 'GLS Canada returned activity for a different parcel');
    }
    const local_time = wallTime(activity.activityDate);
    const status = clean(activity.status, 100);
    const description = clean(activity.statusDetail, 500) || status;
    const code = clean(activity.codeDetail, 24) || clean(activity.code, 24);
    const location = clean(activity.terminal, 120);
    if (!local_time || !status || !description) throw new SchemaError(PROVIDER, 'GLS Canada returned an incomplete activity');
    const stage = glsCanadaStage(code, status);
    return { local_time, description, ...(code ? { provider_code: code } : {}), ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
}

export function parseGlsCanada(body: string, number: string): CarrierResult {
  const data = readJson(body);
  if (!isRecord(data) || !Array.isArray(data.shipments) || data.shipments.length > 50 || !data.shipments.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'GLS Canada returned an invalid shipment list');
  }
  const matches = data.shipments.filter(shipment => typeof shipment.trackingNumber === 'string'
    && shipment.trackingNumber.trim().toUpperCase() === number);
  if (matches.length !== 1) throw new IndeterminateError(PROVIDER, 'GLS Canada did not identify a unique matching shipment');
  const shipment = matches[0]!;
  const current = shipment.currentStatus;
  if (!isRecord(current) || typeof current.name !== 'string' || !current.name.trim()) {
    throw new SchemaError(PROVIDER, 'GLS Canada returned no shipment status');
  }
  if (current.name === 'NORECORD' && shipment.parcels === undefined) throw new NotFoundError(PROVIDER);
  if (current.name === 'NORECORD') throw new SchemaError(PROVIDER, 'GLS Canada returned conflicting shipment data');

  const parcels = shipment.parcels ?? [];
  if (!Array.isArray(parcels) || parcels.length > 100 || !parcels.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'GLS Canada returned an invalid parcel list');
  }
  // The website switches between parcel histories. The shipment summary is shared by all of them.
  const events = parcels.length === 1 ? readScans(parcels[0]) : [];
  const newest = events[0];
  const summary = clean(current.name, 100);
  const summaryStage = glsCanadaNameStage(summary);
  const stage = summaryStage ?? newest?.stage;
  const sameStatus = !!newest && stage === newest.stage;
  const local = wallTime(current.date) ?? (sameStatus ? newest.local_time : undefined);
  const service = clean(shipment.deliveryType, 120);
  const country = isRecord(shipment.consignee) ? shipment.consignee.countryCode : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: sameStatus ? newest.description : summary,
    last_update: null,
    ...(local ? { last_update_local: local } : {}),
    ...(service ? { service_name: service } : {}),
    ...(typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
