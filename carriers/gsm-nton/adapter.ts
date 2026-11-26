import type { AdapterFactory } from '../../core/adapter/index.js';
import { ExpresswebTracker, expresswebTrackingUrl, type ExpresswebTenant } from './expressweb.js';
import { normalizeExpresswebNumber } from './parser.js';

/** GSM NtoN on expressWeb, under the forwarder code its site's tracking form opens. */
export const GSM_NTON: ExpresswebTenant = { provider: 'gsm-nton', name: 'GSM NtoN', fwdCode: 'gexp' };

export const normalizeGsmNtonNumber = (raw: string): string => normalizeExpresswebNumber(raw, GSM_NTON);

/** The tracing page GSM NtoN's site opens for a bill. */
export const gsmNtonTrackingUrl = (raw: string): string => expresswebTrackingUrl(GSM_NTON, normalizeGsmNtonNumber(raw));

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ExpresswebTracker(GSM_NTON, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: GSM_NTON.provider, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
