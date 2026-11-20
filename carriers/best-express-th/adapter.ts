import type { AdapterFactory } from '../../core/adapter/index.js';
import { bestAdapter } from '../best-express-vn/adapter.js';
import { BEST_TH } from './parser.js';

export { BEST_TH } from './parser.js';

export const adapter: AdapterFactory = bestAdapter(BEST_TH);
