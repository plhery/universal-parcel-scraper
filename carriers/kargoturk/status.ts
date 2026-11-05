import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['Paket Kabulü Yapıldı', 'accepted'], ['Transfer Aşamasında', 'in_transit'], ['Şube Karşıladı', 'in_transit'],
  ['Varış Şubesi Karşıladı', 'in_transit'], ['Dağıtıma Çıkarıldı', 'out_for_delivery'], ['Teslim Edildi', 'delivered'],
  ['Şube Ön İade', 'exception'], ['Şubeden İade Olarak Yönlendirildi', 'exception'],
  ['Çıkış Şubesine Geri Geldi', 'in_transit'], ['Gönderen Firmaya İade Edildi', 'returned'],
].map(([wording, stage]) => [normalizeStatusWording(wording!), stage as Stage]));
const NOTICES = ['Alıcıya Sms Gönderildi', 'Alıcı, Kurye Tarafından Arandı', 'Devir Olarak İşaretlendi'];

export const kargoturkStage = (wording: string): Stage | undefined => STAGES.get(normalizeStatusWording(wording));
export const kargoturkNotice = (wording: string): boolean => NOTICES.some(value => normalizeStatusWording(value) === normalizeStatusWording(wording));
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => kargoturkStage(wording),
  gaps: NOTICES.map(wording => ({ wording: normalizeStatusWording(wording),
    note: 'A communication or carry-over flag does not establish a physical movement or delivery outcome.' })),
};
