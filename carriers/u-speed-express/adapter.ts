import type { AdapterFactory } from '../../core/adapter/index.js';
import { itdidaAdapter, ItdidaTracker, type ItdidaOptions } from '../whwdt/itdida.js';
import { U_SPEED } from './parser.js';

export class USpeedTracker extends ItdidaTracker {
  constructor(options: ItdidaOptions = {}) {
    super(U_SPEED, options);
  }
}

export const adapter: AdapterFactory = itdidaAdapter(U_SPEED);
