import type { CarrierResult } from '../../core/result/index.js';
import { navigatorNumber, parseNavigator, type NavigatorTenant } from '../ubx-uk/courier-navigator.js';

/** Flight Logistics' Courier Navigator host, which the MyFlight page on flightlg.com asks. */
export const FLIGHT_LOGISTICS: NavigatorTenant = { carrier: 'flight-logistics', name: 'Flight Logistics', host: 'flightlg.couriernavigator-secure.com' };

export const normalizeFlightLogisticsNumber = (raw: string): string => navigatorNumber(FLIGHT_LOGISTICS, raw);
export const parseFlightLogistics = (body: string, raw: string): CarrierResult => parseNavigator(FLIGHT_LOGISTICS, body, raw);
