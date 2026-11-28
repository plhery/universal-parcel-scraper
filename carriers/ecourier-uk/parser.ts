import type { CarrierResult } from '../../core/result/index.js';
import { navigatorNumber, parseNavigator, type NavigatorTenant } from '../ubx-uk/courier-navigator.js';

/** eCourier's own site, which runs Courier Navigator's tracking search itself. */
export const ECOURIER_UK: NavigatorTenant = { carrier: 'ecourier-uk', name: 'eCourier', host: 'www.ecourier.co.uk' };

export const normalizeEcourierUkNumber = (raw: string): string => navigatorNumber(ECOURIER_UK, raw);
export const parseEcourierUk = (body: string, raw: string): CarrierResult => parseNavigator(ECOURIER_UK, body, raw);
