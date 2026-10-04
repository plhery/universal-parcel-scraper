import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { carrierErrorKind } from '../../core/errors/index.js';
import { adapter } from './adapter.js';

it('keeps a synthetic waybill unknown or reports an HTTP challenge', async () => {
  const carrier = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
  try { expect(await carrier.recognize!('9876000046', { budgetMs: 10_000 })).toMatchObject({ known: false }); }
  catch (error) { expect(['challenge', 'indeterminate']).toContain(carrierErrorKind(error)); }
});
