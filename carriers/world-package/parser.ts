import type { CarrierResult } from '../../core/result/index.js';
import { navigatorNumber, parseNavigator, type NavigatorTenant } from '../ubx-uk/courier-navigator.js';

/** World Package's Courier Navigator host, whose own tracking page the portal links to. */
export const WORLD_PACKAGE: NavigatorTenant = { carrier: 'world-package', name: 'World Package', host: 'wpl-uk.couriernavigator-secure.com' };

export const normalizeWorldPackageNumber = (raw: string): string => navigatorNumber(WORLD_PACKAGE, raw);
export const parseWorldPackage = (body: string, raw: string): CarrierResult => parseNavigator(WORLD_PACKAGE, body, raw);
