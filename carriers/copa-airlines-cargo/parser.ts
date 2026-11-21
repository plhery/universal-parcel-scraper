import { parseSmartKargoTracking, type SmartKargoPortal } from '../akasa-air-cargo/smartKargo.js';
import { stageForWording } from './status.js';

export const copaPortal: SmartKargoPortal = {
  provider: 'copa-airlines-cargo',
  tracker: 'https://copa.smartkargo.com/FrmAWBTracking.aspx',
  prefix: '230',
  route: 'link',
  stageForWording,
};

export const parseTracking = (html: string, number: string) => parseSmartKargoTracking(html, number, copaPortal);
