/**
 * Meixi Express's rows: the firm's own text and the FlowLink system's code (`CNCode`, empty on some rows), kept as
 * the scan's code. An entry of `statuses.json` records a code with a text, each place in brackets read as 【…】; a
 * code whose every recorded text means one stage gives it to a text the map does not know. Anything else goes
 * through the shared wording rules.
 */
import { flowlinkStatusMap } from '../jdxexpress/flowlinkStatus.js';
import statuses from './statuses.json' with { type: 'json' };

export const statusMap = flowlinkStatusMap(statuses.entries);
