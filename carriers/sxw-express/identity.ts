import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';
import { translatedScanPolicy } from '../../core/status/english.js';
import { hualeiPlace } from '../gzyl/text.js';
import { sxwEnglish } from './status.js';

const translated = translatedScanPolicy('sxw-express', (wording) => sxwEnglish(null, wording));

// Rows stored in the platform's Chinese before the adapter showed their English
// are taken over by the English row at the same instant and place. Earlier
// releases read a row abroad on Beijing's clock; it now shows its wall clock
// under its place's offset and takes over the row stored from it. A row stored
// at a word the platform prints for no place, such as "海关" on a customs row,
// is taken over by the same row without it.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  ...translated,
  matches: (incoming, stored) => translated.matches!(incoming, stored)
    || matchesDroppedLocation(incoming, stored, (location) => !hualeiPlace(location)),
  relabelledFrom: 'Asia/Shanghai',
};
