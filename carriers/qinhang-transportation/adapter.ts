import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { normalizeQinhangNumber, QINHANG, QINHANG_API, withHandoff } from './parser.js';

export { QINHANG_API, QINHANG_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function qinhangLookupUrl(number: string): string {
  return ginfoLookupUrl(QINHANG_API, number);
}

/** Qinhang's tracker: the shared GInfo record, with the US trucking firm a row names. */
export class QinhangTracker {
  private readonly records: GinfoTracker;

  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) {
    this.records = new GinfoTracker(QINHANG, options);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    return withHandoff(await this.records.fetch(raw, context), raw);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new QinhangTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: QINHANG.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeQinhangNumber(number))),
  };
};
