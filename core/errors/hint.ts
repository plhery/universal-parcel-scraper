import { CarrierError, carrierErrorKind, InputRequiredError, retryAfterMsOf, type CarrierErrorKind } from './index.js';

export interface FailureHint {
  kind: CarrierErrorKind;
  retryAfterMs?: number;
  /** With the kind `input_required`, the input a source asks for, as the source names it. */
  field?: string;
  /** With `field`, the catalog id of the carrier that asks for it, when it is known. */
  carrier?: string;
}

/**
 * The kind of any failure. An error outside the taxonomy that the runtime
 * raises while reading a reply (a TypeError, RangeError or SyntaxError) means
 * the payload was not the expected shape, so it is `schema`: retrying at once
 * cannot help. Anything else untyped stays a transport failure.
 */
export function failureKind(error: unknown): CarrierErrorKind {
  return carrierErrorKind(error)
    ?? (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError ? 'schema' : 'transport');
}

/** The input request whose kind `carrierErrorKind` reads, the first carrier error in the cause chain. */
function inputRequest(error: unknown): InputRequiredError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof CarrierError) return current instanceof InputRequiredError ? current : undefined;
    current = current.cause;
  }
  return undefined;
}

/** The upstream's advice; consumers own their refresh cadence and backoff. */
export function failureHint(error: unknown): FailureHint {
  const kind = failureKind(error);
  const retryAfterMs = retryAfterMsOf(error);
  const request = kind === 'input_required' ? inputRequest(error) : undefined;
  return { kind, ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(request ? { field: request.field, ...(request.carrier === undefined ? {} : { carrier: request.carrier }) } : {}) };
}
