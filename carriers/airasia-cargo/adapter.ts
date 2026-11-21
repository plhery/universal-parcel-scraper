import { smartKargoAdapter } from '../akasa-air-cargo/adapter.js';
import { airAsiaPortal } from './parser.js';

export const adapter = smartKargoAdapter(airAsiaPortal);
