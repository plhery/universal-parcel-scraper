import { IndeterminateError } from '../../core/errors/index.js';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { SXW } from './parser.js';

export class SxwTracker extends HualeiTracker {
  private readonly allowPlainHttp: boolean;
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] & { allowPlainHttp?: boolean } = {}) {
    super(SXW, options);
    this.allowPlainHttp = options.allowPlainHttp === true;
  }

  override async fetch(raw: string, context: TrackingContext = {}) {
    context.signal?.throwIfAborted();
    if (!this.allowPlainHttp) throw new IndeterminateError(SXW.provider, 'Plain HTTP tracking is disabled');
    return super.fetch(raw, context);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SxwTracker({ allowPlainHttp: environment.env.SXW_EXPRESS_ALLOW_HTTP === '1', fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'sxw-express', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
