import { smartKargoAdapter } from '../akasa-air-cargo/adapter.js';
import { indigoPortal } from './parser.js';

export const adapter = smartKargoAdapter(indigoPortal);
