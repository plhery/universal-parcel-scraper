/**
 * Scan templates: common scans told in words every reader's language has. An entry of a carrier's
 * `statuses.json` can name a template of data/scan-templates.json, which holds each template's text in every
 * language the app shows. `scanTemplate()` names the template of one scan, by its provider code or its
 * wording, with the language of that wording, so an app can show the template's text to a reader of another
 * language and keep the carrier's own words for a reader of that one.
 */
import type { CarrierId } from '../../generated/catalog.js';
import { SCAN_TEMPLATE_KEYS } from '../../generated/scanTemplates.js';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { normalizeStatusWording } from './statusMap.js';

export interface ScanTemplate {
  /** The template's id in data/scan-templates.json. */
  readonly id: string;
  /** The language of the carrier's wording the template stands for, such as `en` or `pt-br`. */
  readonly language: string;
}

export interface TemplatedScan {
  readonly providerCode?: string | null;
  readonly description: string;
}

function templateKeys(carrier: string) {
  if (Object.hasOwn(SCAN_TEMPLATE_KEYS, carrier)) return SCAN_TEMPLATE_KEYS[carrier];
  const adapter = Object.hasOwn(CARRIER_DEFINITIONS, carrier)
    ? CARRIER_DEFINITIONS[carrier as CarrierId].tracking.adapter
    : null;
  return adapter && Object.hasOwn(SCAN_TEMPLATE_KEYS, adapter) ? SCAN_TEMPLATE_KEYS[adapter] : undefined;
}

/**
 * The template of a carrier's scan, by its provider code and then its wording, or undefined when its
 * `statuses.json` names none. A carrier that another folder's adapter serves reads that folder's entries.
 */
export function scanTemplate(carrier: string, scan: TemplatedScan): ScanTemplate | undefined {
  const keys = templateKeys(carrier);
  if (!keys) return undefined;
  const code = scan.providerCode ? String(scan.providerCode) : '';
  const wording = normalizeStatusWording(scan.description);
  const found = (code && keys.codes && Object.hasOwn(keys.codes, code) ? keys.codes[code] : undefined)
    ?? (wording && keys.wordings && Object.hasOwn(keys.wordings, wording) ? keys.wordings[wording] : undefined);
  return found ? { id: found[0], language: found[1] } : undefined;
}
