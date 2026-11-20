import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { garuda, parseTracking, type IcmsCarrier } from './parser.js';

const origin = 'https://icms.garuda-indonesia.com';
const frame = origin + '/HtmlFiles/AWBTracking/AWBTracking.html';
const endpoint = origin + '/Services/Shipment/AWBTrackingService.svc/GetAWBTrackingRecord';
const verification = /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource|verify you are human|captcha (?:required|invalid)/i;

export function createIcmsAdapter(
  { id: provider, name, prefix }: IcmsCarrier,
  parse: (data: unknown, serial: string) => CarrierResult,
): AdapterFactory {
  const numberPattern = new RegExp('^(?:' + prefix + '[\\s-]?)?(\\d{8})$');
  return environment => ({
    id: provider,
    recordsSteps: true,
    steps: ['direct'],
    async track(input, context = {}) {
      const serial = numberPattern.exec(input.number.trim())?.[1];
      if (!serial) throw new InvalidInputError(provider, 'Enter a ' + name + ' ' + prefix + ' air waybill or eight-digit serial');

      return runSteps({
        carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      }, [{
        id: 'direct',
        async run({ signal, remainingMs }) {
          const waybill = new URLSearchParams({ BasedOn: '0', AWBNo: serial, CarrierCode: prefix });
          // These are the fields sent by the carrier's public iframe for anonymous waybill lookup.
          const query = new URLSearchParams(waybill);
          query.set('AccountSNo', '0');
          query.set('flag', '0');
          query.set('AWBTrackingCaptchaCode', '');
          const { response, bytes } = await fetchBounded(endpoint + '?' + query.toString(), {
            signal, headers: {
              Accept: 'application/json', Referer: frame + '?' + waybill.toString(), 'X-Requested-With': 'XMLHttpRequest',
              'User-Agent': userAgentOf(environment.userAgent),
            },
          }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 600_000, allowHttpStatuses: [403] });
          const body = decodeText(bytes);
          if (response.status === 403 || verification.test(body)) {
            throw new ChallengeError(provider, name + ' requires verification');
          }
          let data: unknown;
          try {
            data = JSON.parse(body);
            if (typeof data === 'string') data = JSON.parse(data);
          } catch (cause) {
            throw new SchemaError(provider, name + ' returned unreadable tracking JSON', { cause });
          }
          return parse(data, serial);
        },
      }]);
    },
  });
}

export const adapter = createIcmsAdapter(garuda, parseTracking);
