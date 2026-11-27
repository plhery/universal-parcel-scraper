import type { AdapterFactory } from '../../core/adapter/index.js';
import { itdidaAdapter, ItdidaTracker, type ItdidaOptions } from '../whwdt/itdida.js';
import { XUN_TIAN } from './parser.js';

export class XunTianTracker extends ItdidaTracker {
  constructor(options: ItdidaOptions = {}) {
    super(XUN_TIAN, options);
  }
}

export const adapter: AdapterFactory = itdidaAdapter(XUN_TIAN);
