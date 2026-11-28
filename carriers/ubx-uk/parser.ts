import type { CarrierResult } from '../../core/result/index.js';
import { navigatorNumber, parseNavigator, type NavigatorTenant } from './courier-navigator.js';

/** UBX UK's Courier Navigator host, which the tracking page on ubx.uk.net asks. */
export const UBX_UK: NavigatorTenant = { carrier: 'ubx-uk', name: 'UBX UK', host: 'ubx.couriernavigator-secure.com' };

export const normalizeUbxUkNumber = (raw: string): string => navigatorNumber(UBX_UK, raw);
export const parseUbxUk = (body: string, raw: string): CarrierResult => parseNavigator(UBX_UK, body, raw);
