import type { AdapterFactory } from '../../core/adapter/index.js';
import { LexTracker } from '../lex-id/lex.js';
import { LEX_TH } from './parser.js';

export const adapter: AdapterFactory = environment => {
  const tracker = new LexTracker(LEX_TH, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'lex-th', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
