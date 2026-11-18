import { translatedScanPolicy } from '../../core/status/english.js';
import { sxwEnglish } from './status.js';

// Rows stored in the platform's Chinese before the adapter showed their English
// are taken over by the English row at the same instant and place. Earlier
// releases read a row abroad on Beijing's clock; it now shows its wall clock
// under its place's offset and takes over the row stored from it.
export const sameInstantIdentityPolicy = {
  ...translatedScanPolicy('sxw-express', (wording) => sxwEnglish(null, wording)),
  relabelledFrom: 'Asia/Shanghai',
};
