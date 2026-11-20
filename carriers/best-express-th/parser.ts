import type { BestRegion } from '../best-express-vn/parser.js';

export const BEST_TH: BestRegion = {
  carrier: 'best-express-th', provider: 'BEST Express Thailand', site: 'https://www.best-inc.co.th',
  appKey: '4801fe3ea2fda54bd2aeedc9d28f2999', // gitleaks:allow
  // The tracker's nation with the English its page offers first, so the scans read in plain words.
  language: { 'X-Nat': 'th-TH', 'lang-type': 'en-US', 'X-Lan': 'EN' },
  timezone: 'Asia/Bangkok', signer: /^(\S.*?)\s+POD$/u,
};
