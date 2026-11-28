import { courierNavigatorAdapter } from '../ubx-uk/courier-navigator.js';
import { ECOURIER_UK } from './parser.js';

export const adapter = courierNavigatorAdapter(ECOURIER_UK);
