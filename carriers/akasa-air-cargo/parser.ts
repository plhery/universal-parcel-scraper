import { normalizeSmartKargoNumber, parseSmartKargoTracking, smartKargoFormFields } from './smartKargo.js';
import { stageForWording } from './status.js';

export const tracker = 'https://cargo.akasaair.com/FrmAWBTracking.aspx';
export const akasaPortal = { provider: 'akasa-air-cargo', tracker, prefix: '516', stageForWording };

export const normalizeAirWaybill = (raw: string) => normalizeSmartKargoNumber(raw, akasaPortal);
export const formFields = (html: string, number: string) => smartKargoFormFields(html, number, akasaPortal);
export const parseTracking = (html: string, number: string) => parseSmartKargoTracking(html, number, akasaPortal);
