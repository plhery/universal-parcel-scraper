import { parseSmartKargoTracking, type SmartKargoPortal } from '../akasa-air-cargo/smartKargo.js';
import { stageForWording } from './status.js';

// 807 is AirAsia's own prefix and 975 Indonesia AirAsia's, whose waybills the tracker answers.
export const airAsiaPortal: SmartKargoPortal = {
  provider: 'airasia-cargo', tracker: 'https://airasia.smartkargo.com/FrmAWBTracking.aspx',
  prefix: ['807', '975'], route: 'link', stageForWording,
};

export const parseTracking = (html: string, number: string) => parseSmartKargoTracking(html, number, airAsiaPortal);
