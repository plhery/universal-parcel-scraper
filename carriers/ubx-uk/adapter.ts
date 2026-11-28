import { courierNavigatorAdapter } from './courier-navigator.js';
import { UBX_UK } from './parser.js';

export const adapter = courierNavigatorAdapter(UBX_UK);
