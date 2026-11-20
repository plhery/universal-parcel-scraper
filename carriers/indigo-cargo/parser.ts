import { parseSmartKargoTracking } from '../akasa-air-cargo/smartKargo.js';
import { stageForWording } from './status.js';

export const indigoPortal = {
  provider: 'indigo-cargo',
  tracker: 'https://6ecargo.goindigo.in/FrmAWBTracking.aspx',
  prefix: '312',
  stageForWording,
};

export const parseTracking = (html: string, number: string) => parseSmartKargoTracking(html, number, indigoPortal);
