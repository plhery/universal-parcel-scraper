import { translatedScanPolicy } from '../../core/status/english.js';
import { jAndTMxEnglish } from './status.js';

// The tracker labels its scans in the reader's language, so a parcel read by readers of Spanish and
// English gets each scan in both. At one instant and place, a scan in one language takes over the
// row stored in the other when its label translates the stored one.
export const sameInstantIdentityPolicy = translatedScanPolicy('j-and-t-mx', jAndTMxEnglish);
