import { carrierErrorKind, retryAfterMsOf, type CarrierErrorKind } from './index.js';

export interface FailureHint {
  kind: CarrierErrorKind;
  retryAfterMs?: number;
}

/** The upstream's advice; consumers own their refresh cadence and backoff. */
export function failureHint(error: unknown): FailureHint {
  const kind = carrierErrorKind(error) ?? 'transport';
  const retryAfterMs = retryAfterMsOf(error);
  return { kind, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}
