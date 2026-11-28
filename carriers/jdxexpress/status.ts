/**
 * JDX Express's rows: a text, its own or one the system relays from the courier in China, and the FlowLink
 * system's code (`CNCode`, empty on many rows), kept as the scan's code. An entry of `statuses.json` records a
 * code with a text, each place in brackets read as […] or 【…】 and an onward waybill as #; a code whose every
 * recorded text means one stage gives it to a text the map does not know. Anything else goes through the shared
 * wording rules.
 */
import { flowlinkStatusMap } from './flowlinkStatus.js';
import statuses from './statuses.json' with { type: 'json' };

export const statusMap = flowlinkStatusMap(statuses.entries);
