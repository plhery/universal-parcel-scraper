import type { CarrierResult } from '../../core/result/index.js';
import { navigatorNumber, parseNavigator, type NavigatorTenant } from '../ubx-uk/courier-navigator.js';

/** Hart2Hart Express's Courier Navigator host, whose own tracking page the portal links to. */
export const HART2HART: NavigatorTenant = { carrier: 'hart2hart-express', name: 'Hart2Hart Express', host: 'harttohart.couriernavigator-secure.com' };

export const normalizeHart2HartNumber = (raw: string): string => navigatorNumber(HART2HART, raw);
export const parseHart2Hart = (body: string, raw: string): CarrierResult => parseNavigator(HART2HART, body, raw);
