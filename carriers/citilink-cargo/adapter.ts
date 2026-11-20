import { createIcmsAdapter } from '../garuda-indonesia-cargo/adapter.js';
import { citilink, parseTracking } from './parser.js';

export const adapter = createIcmsAdapter(citilink, parseTracking);
