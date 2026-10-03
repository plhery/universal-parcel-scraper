import { normalizeTrackingNumber } from '../detection/index.js';

const PLANZER_SHARED_HOST = 'trackandtrace.planzergroup.com';
const PLANZER_SHARED_PATH = /^\/shared\/sendungen\/([^/]+)\/?$/;
const PLANZER_ACCESS_KEY = /^[A-Za-z0-9_-]{32,256}$/;
const DACHSER_HOST = 'customeriberia.dachser.com';
const DACHSER_PAGE_PATH = '/customerarea/utilidades/seguimiento-publico/detalle';
const CAPABILITY_VALUE = /^[A-Za-z0-9_-]{4,256}$/;
// eslint-disable-next-line no-control-regex -- control characters are what this rejects
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const ALLOWED_QUERY_KEYS = new Set([
  'hash',
  'cliente',
  'numeroUnico',
  'referencia',
  'fecha',
  'clave',
  'user',
  'idioma',
  'expedicion',
  'tipoMail',
  'error',
  'origen',
  'usuario',
]);

export function validatePlanzerSharedUrl(rawUrl: string, trackingNumber: string): string {
  const value = rawUrl.trim();
  if (value.length < 1 || value.length > 4_096) {
    throw new TypeError('Paste the complete Planzer tracking URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError('Paste a valid Planzer tracking URL', { cause: error });
  }
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== PLANZER_SHARED_HOST
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || url.hash
  ) {
    throw new TypeError(`Planzer shared links must use https://${PLANZER_SHARED_HOST}`);
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    throw new TypeError('Paste a valid Planzer tracking URL', { cause: error });
  }
  const match = PLANZER_SHARED_PATH.exec(pathname);
  if (!match) throw new TypeError('Paste a Planzer shared shipment URL');
  if (normalizeTrackingNumber(match[1]!) !== normalizeTrackingNumber(trackingNumber)) {
    throw new TypeError('The Planzer URL belongs to a different tracking number');
  }
  const accessKeys = url.searchParams.getAll('accessKey');
  if (accessKeys.length !== 1 || !PLANZER_ACCESS_KEY.test(accessKeys[0]!)) {
    throw new TypeError('The Planzer URL must include its accessKey');
  }
  return url.toString();
}

export function validateDachserTrackingUrl(rawUrl: string, trackingNumber: string): string {
  const value = rawUrl.trim();
  if (value.length < 1 || value.length > 4_096) {
    throw new TypeError('Paste the complete Dachser tracking URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError('Paste a valid Dachser tracking URL', { cause: error });
  }
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== DACHSER_HOST
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || url.hash
  ) throw new TypeError(`Dachser links must use https://${DACHSER_HOST}`);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    throw new TypeError('Paste a valid Dachser tracking URL', { cause: error });
  }
  if (pathname !== DACHSER_PAGE_PATH && pathname !== `${DACHSER_PAGE_PATH}/`) {
    throw new TypeError('Paste a Dachser public shipment detail URL');
  }

  const values = new Map<string, string>();
  for (const [name, parameter] of url.searchParams) {
    if (!ALLOWED_QUERY_KEYS.has(name)) {
      throw new TypeError('The Dachser URL contains an unsupported parameter');
    }
    if (values.has(name)) throw new TypeError('The Dachser URL contains a duplicate parameter');
    if (!parameter || parameter.length > 256 || CONTROL_CHARACTER.test(parameter)) {
      throw new TypeError('The Dachser URL contains an invalid parameter');
    }
    values.set(name, parameter);
  }
  const uniqueNumber = values.get('numeroUnico');
  if (!uniqueNumber) throw new TypeError('The Dachser URL must include its shipment number');
  if (normalizeTrackingNumber(uniqueNumber) !== normalizeTrackingNumber(trackingNumber)) {
    throw new TypeError('The Dachser URL belongs to a different tracking number');
  }
  const capabilityHash = values.get('hash');
  const capabilityKey = values.get('clave');
  const capabilityDate = values.get('fecha');
  const hasHash = Boolean(capabilityHash && CAPABILITY_VALUE.test(capabilityHash));
  const hasKey = Boolean(
    capabilityKey
    && capabilityDate
    && CAPABILITY_VALUE.test(capabilityKey)
    && /^\d{8}$/.test(capabilityDate),
  );
  if (!hasHash && !hasKey) {
    throw new TypeError('The Dachser URL must include its access parameters');
  }
  url.protocol = 'https:';
  url.hostname = DACHSER_HOST;
  url.port = '';
  return url.toString();
}
