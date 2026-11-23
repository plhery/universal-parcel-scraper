import { icargoNeoAdapter } from '../china-airlines-cargo/icargoNeo.js';
import { srilankanPortal } from './parser.js';

export const adapter = icargoNeoAdapter(srilankanPortal);
