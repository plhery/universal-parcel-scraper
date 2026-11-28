import { courierNavigatorAdapter } from '../ubx-uk/courier-navigator.js';
import { FLIGHT_LOGISTICS } from './parser.js';

export const adapter = courierNavigatorAdapter(FLIGHT_LOGISTICS);
