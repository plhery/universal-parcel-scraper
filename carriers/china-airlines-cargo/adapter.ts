import { icargoNeoAdapter } from './icargoNeo.js';
import { chinaAirlinesPortal } from './parser.js';

export const adapter = icargoNeoAdapter(chinaAirlinesPortal);
