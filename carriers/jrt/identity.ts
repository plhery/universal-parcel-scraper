import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { translatedScanPolicy } from '../../core/status/english.js';
import { matchesRereadText } from '../gzyl/identity.js';
import { jrtCountryPlace, jrtEnglish } from './status.js';

// Rows stored in JRT's Chinese before the adapter showed their English, and
// the airport row stored with the flight it books, are taken over by the
// English row at the same instant and place; a row stored with a space GBK
// lost, by the same row with the space. A DHL row stored beside the country's
// code in lower case ("de") is taken over by the same row beside its upper case.
const translated = translatedScanPolicy('jrt', (wording) => jrtEnglish(null, wording));
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  ...translated,
  matches: (incoming, stored) => translated.matches!(incoming, stored) || matchesRereadText(incoming, stored)
    || matchesRereadLocation(incoming, stored, jrtCountryPlace),
};
