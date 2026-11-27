import type { AdapterFactory } from '../../core/adapter/index.js';
import { itdidaAdapter, ItdidaTracker, type ItdidaOptions } from './itdida.js';
import { WHWDT } from './parser.js';

export { WHWDT_HOST } from './parser.js';

export class WhwdtTracker extends ItdidaTracker {
  constructor(options: ItdidaOptions = {}) {
    super(WHWDT, options);
  }
}

export const adapter: AdapterFactory = itdidaAdapter(WHWDT);
