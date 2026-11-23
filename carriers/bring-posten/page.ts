import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import { isRecord } from '../../core/types.js';

/** The portal's tracking page route, whose loader answers for one number. */
export const PAGE_ROUTE = 'routes/$sporing.$trackingNumber';

// React Router writes a loader's data as a turbo-stream: a JSON array of values in which objects and arrays hold the
// indexes of their members, negative indexes stand for values JSON lacks, and a typed value is an array headed by its
// type's name. Deferred values follow on later lines, one for each promise.
const SPECIAL = new Map<number, unknown>([[-1, undefined], [-2, Number.NaN], [-3, -Infinity], [-4, -0], [-5, null],
  [-6, Infinity], [-7, undefined]]);
const MAX_DEPTH = 64;

/** A typed value: a date, a deferred promise, a thrown response, a redirect. The page's tracking data holds none it reads. */
export interface TypedValue { $type: string; args?: unknown[] }

const invalid = () => new SchemaError('Bring', 'Bring returned an invalid tracking page stream');

/** The first line of a turbo-stream, decoded. Deferred values are left out; a thrown response keeps its fields. */
export function decodePageStream(stream: string): unknown {
  let values: unknown;
  try { values = JSON.parse(stream.split('\n', 1)[0]!); } catch { throw invalid(); }
  if (!Array.isArray(values) || !values.length) throw invalid();
  const table: readonly unknown[] = values;
  const done = new Map<number, unknown>();
  const open = new Set<number>();
  const read = (index: unknown, depth: number): unknown => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index >= table.length) throw invalid();
    if (index < 0) {
      if (!SPECIAL.has(index)) throw invalid();
      return SPECIAL.get(index);
    }
    if (done.has(index)) return done.get(index);
    if (open.has(index) || depth > MAX_DEPTH) throw invalid();
    const value = table[index];
    if (value === null || typeof value !== 'object') {
      done.set(index, value);
      return value;
    }
    open.add(index);
    let decoded: unknown;
    if (Array.isArray(value) && typeof value[0] === 'string') {
      // React Router's thrown response lists its data, status and status text by index, and its redirect the object
      // that names the target; other types are no data here.
      decoded = value[0] === 'ErrorResponse' || value[0] === 'SingleFetchRedirect'
        ? { $type: value[0], args: value.slice(1).map(member => read(member, depth + 1)) } satisfies TypedValue
        : { $type: value[0] } satisfies TypedValue;
    } else if (Array.isArray(value)) {
      decoded = value.map(member => read(member, depth + 1));
    } else {
      decoded = Object.fromEntries(Object.entries(value).map(([key, member]) => {
        const name = /^_\d{1,9}$/.test(key) ? table[Number(key.slice(1))] : undefined;
        if (typeof name !== 'string') throw invalid();
        return [name, read(member, depth + 1)];
      }));
    }
    open.delete(index);
    done.set(index, decoded);
    return decoded;
  };
  return read(0, 0);
}

/** Posten's own tracking page, where Bring's page sends some items from abroad that Posten handles. */
export const POSTEN_PAGE_HOST = 'sporing.posten.no';

/**
 * Whether the page sends the lookup to Posten's own tracking page for the same number, which shows the item Bring's
 * page and JSON route do not. Any other redirect is not followed.
 */
export function redirectsToPosten(stream: string, number: string): boolean {
  let decoded: unknown;
  try { decoded = decodePageStream(stream); } catch { return false; }
  const redirect = decoded as Partial<TypedValue> | undefined;
  const target = redirect?.$type === 'SingleFetchRedirect' && isRecord(redirect.args?.[0]) ? redirect.args[0].redirect : undefined;
  if (typeof target !== 'string') return false;
  let url: URL;
  try { url = new URL(target); } catch { return false; }
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return false; }
  return url.protocol === 'https:' && url.hostname === POSTEN_PAGE_HOST && url.port === '' && path.toUpperCase() === `/SPORING/${number}`;
}

/**
 * The consignment the tracking page shows, as the JSON route's reply holds it. The page's loader also finds
 * parcels the JSON route answers NOT FOUND for, such as one delivered in Sweden. Its not-found is a thrown 404.
 */
export function pageConsignment(stream: string, status: number): Record<string, unknown> {
  const decoded = decodePageStream(stream);
  if ((decoded as Partial<TypedValue> | undefined)?.$type === 'SingleFetchRedirect') throw new IndeterminateError('Bring', 'Bring sent the lookup to another page');
  const route = isRecord(decoded) ? decoded[PAGE_ROUTE] : undefined;
  if (!isRecord(route)) throw new SchemaError('Bring', 'Bring changed its tracking page data');
  if (route.error !== undefined) {
    const error = route.error as Partial<TypedValue> | undefined;
    const notFound = status === 404 && error?.$type === 'ErrorResponse' && error.args?.[0] === 'NOT_FOUND' && error.args[1] === 404;
    throw new IndeterminateError('Bring', 'No identity-bound parcel history', notFound ? { reason: 'portal_not_found' } : undefined);
  }
  if (status !== 200) throw new SchemaError('Bring', 'Bring returned tracking page data with an error status');
  const data = route.data;
  if (isRecord(data) && data._type === 'MULTIPLE_CONSIGNMENTS') throw new IndeterminateError('Bring', 'No complete single-piece consignment');
  if (!isRecord(data) || data._type !== 'SINGLE_CONSIGNMENT' || !isRecord(data.consignment)) throw new SchemaError('Bring', 'Bring changed its tracking page data');
  return { consignmentWithDomainAsync: data.consignment };
}
