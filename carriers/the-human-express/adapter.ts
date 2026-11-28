import type { AdapterFactory } from '../../core/adapter/index.js';
import { packageLogsAdapter } from './packageLogs.js';
import { THE_HUMAN } from './parser.js';

export const adapter: AdapterFactory = packageLogsAdapter(THE_HUMAN);
