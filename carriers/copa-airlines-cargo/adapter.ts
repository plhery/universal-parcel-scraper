import { smartKargoAdapter } from '../akasa-air-cargo/adapter.js';
import { copaPortal } from './parser.js';

export const adapter = smartKargoAdapter(copaPortal);
