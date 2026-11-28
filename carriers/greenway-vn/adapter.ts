import type { AdapterFactory } from '../../core/adapter/index.js';
import { packageLogsAdapter } from '../the-human-express/packageLogs.js';
import { GREENWAY } from './parser.js';

export const adapter: AdapterFactory = packageLogsAdapter(GREENWAY);
