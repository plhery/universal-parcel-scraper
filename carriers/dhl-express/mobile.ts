import { randomBytes, randomUUID } from 'node:crypto';
import type { AdapterEnvironment, LookupBudget } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { decodeText, fetchBounded, parseJsonBytes } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

const PROVIDER = 'DHL Express';
const APP = 'com.dhl.exp.dhlmobile';
const VERSION = '6.1.0';
const API = `https://dhle.dhl.com/access/access/${APP}`;
// The shared guest application bearer is deliberately distributed with this adapter.
const APPLICATION_BEARER = "Bearer MtX6uKNcGM295BXaJGa83GFhTHCL9a";

/** Mobile errors can arrive as JSON strings or envelopes with HTTP 200. */
function checkReply(payload: unknown, httpStatus: number): void {
  const root = isRecord(payload) ? payload : {};
  const nested = isRecord(root.error) ? root.error : {};
  const codes = [payload, root.error, root.statusCode, root.status, root.code, root.message,
    nested.error, nested.statusCode, nested.status, nested.code, nested.message]
    .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
    .map((value) => String(value).trim());
  if (codes.some((code) => ['429', 'temporary_blocked', 'max_attempts_reached'].includes(code))) throw new RateLimitedError(PROVIDER);
  if (codes.some((code) => ['401', '403', '428', 'DRG10012', 'DRG10013'].includes(code))) throw new ChallengeError(PROVIDER, 'DHL mobile tracking requires verification', httpStatus === 200 ? undefined : { status: httpStatus });
  const serverError = codes.find((code) => /^5\d{2}$/.test(code));
  if (serverError) throw new UpstreamHttpError(PROVIDER, Number(serverError));
}

/** Verify current application configuration before treating an empty tracking list as missing. */
export async function mobileTracking(number: string, budget: LookupBudget, environment: AdapterEnvironment, device: string): Promise<unknown> {
  const request = async (method: string, service: string, extra: Record<string, unknown>): Promise<unknown> => {
    budget.signal.throwIfAborted();
    const { response, bytes } = await fetchBounded(`${API}?${new URLSearchParams({ appVersion: VERSION, service: `${service}-${method}` })}`, {
      method: 'POST', signal: budget.signal,
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: APPLICATION_BEARER,
        'cache-control': 'no-cache', transactionId: randomUUID(), 'user-agent': environment.userAgent ?? 'Mozilla/5.0' },
      body: JSON.stringify({ method, service, authentication: { provider: 'DEMP.RS1', token: '', login: '' },
        data: { parameters: {}, timezoneOffset: '+00:00', appVersion: VERSION, UIClient: 'Android',
          device_info: { device_unique_id: device, deviceId: device, device_language: 'en', app_id: APP,
            platform: 'Android', appStore: 'PlayStore', gpsLoc: '', pushToken: '' }, ...extra } }),
    }, { provider: PROVIDER, timeoutMs: budget.remainingMs(), maxBytes: 1_000_000, fetcher: environment.fetcher,
      allowHttpStatuses: [400, 404, 410, 503] });
    budget.signal.throwIfAborted();
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'DHL mobile tracking endpoint is unavailable', { status: response.status });
    if (/^\s*</.test(decodeText(bytes))) {
      if (response.status !== 200) throw new UpstreamHttpError(PROVIDER, response.status);
      throw new ChallengeError(PROVIDER, 'DHL mobile tracking rejected the request');
    }
    let payload: unknown;
    try { payload = parseJsonBytes(bytes, PROVIDER); }
    catch (error) {
      if (response.status !== 200) throw new UpstreamHttpError(PROVIDER, response.status);
      throw new SchemaError(PROVIDER, 'DHL mobile tracking returned invalid JSON', { cause: error });
    }
    checkReply(payload, response.status);
    if (response.status !== 200) throw new UpstreamHttpError(PROVIDER, response.status);
    return payload;
  };
  const settings = await request('countrySettingsBySettingName', 'common', { countryCode: 'GB', settingNames: ['api_awb_encryption'] });
  if (!Array.isArray(settings) || settings.length > 20 || settings.some((setting) => !isRecord(setting))) throw new SchemaError(PROVIDER, 'DHL mobile tracking returned invalid settings');
  const encryption = settings.filter(isRecord).filter((setting) => setting.name === 'api_awb_encryption');
  if (encryption.length !== 1 || (encryption[0]!.value !== 'N' && encryption[0]!.value !== 'Y')) throw new SchemaError(PROVIDER, 'DHL mobile tracking returned invalid encryption settings');
  if (encryption[0]!.value === 'Y') throw new ChallengeError(PROVIDER, 'DHL mobile tracking requires waybill encryption');
  return request('tracking', 'shipments', { airWayBill: number, countryCode: 'GB', languageCd: 'en', addShipmentToODD: 'N',
    moreDetails: 'Y', iv: Buffer.from(randomBytes(8).toString('hex')).toString('base64'), captchaVerificationData: {} });
}
