import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

/** The item code as Post Aruba's tracker takes it: an S10 code, or a UW customs label issued in Aruba. */
function itemCode(raw: string): string {
  const number = raw.trim().toUpperCase();
  if (!isValidS10TrackingNumber(number) && !/^UW\d{9}AW$/.test(number)) throw new InvalidInputError(provider, 'Enter a Post Aruba postal item code');
  return number;
}

export const adapter: AdapterFactory = environment => {
  const lookup = (raw: string, context: TrackingContext = {}) => {
    const number = itemCode(raw);
    return runSteps({ carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = `https://cds.postaruba.com/ipswt/IPSWeb_item_events.aspx?itemid=${encodeURIComponent(number)}`;
        const { bytes } = await fetchBounded(url, {
          signal, headers: { 'User-Agent': userAgentOf(environment.userAgent) },
        }, { provider, timeoutMs: remainingMs, maxBytes: 512 * 1024, fetcher: environment.fetcher });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  };
  return {
    id: provider, recordsSteps: true, steps: ['direct'],
    track: (input, context) => lookup(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => lookup(number, context), () => accepted(() => itemCode(number))),
  };
};
