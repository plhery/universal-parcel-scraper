import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { freightwaysApi, FreightwaysTracker } from '../nz-couriers/freightways.js';
import { PASS_THE_PARCEL, passTheParcelQuery } from './parser.js';

/** The Freightways lookup under Post Haste's name, which holds Pass the Parcel's codes. */
export const PASS_THE_PARCEL_API = freightwaysApi(PASS_THE_PARCEL);

/**
 * The group's tracker for Parcel Tracking Codes alone: the lookup under Post
 * Haste's name also holds Post Haste's own numbers, which are refused here.
 */
export class PassTheParcelTracker extends FreightwaysTracker {
  constructor(options: ConstructorParameters<typeof FreightwaysTracker>[1] = {}) { super(PASS_THE_PARCEL, options); }

  override async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    passTheParcelQuery(raw);
    return super.fetch(raw, context);
  }
}

/** One direct step, without recognition or tracking link. */
export const adapter: AdapterFactory = (environment) => {
  const tracker = new PassTheParcelTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PASS_THE_PARCEL.carrier, recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
