import { courierNavigatorAdapter } from '../ubx-uk/courier-navigator.js';
import { HART2HART } from './parser.js';

export const adapter = courierNavigatorAdapter(HART2HART);
