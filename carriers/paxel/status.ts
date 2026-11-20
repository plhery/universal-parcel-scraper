import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

interface PaxelScan {
  description: string;
  stage?: Stage;
}

/** Only recognised shipment wording survives; courier names and arbitrary suffixes do not. */
export function paxelScan(wording: string): PaxelScan {
  if (/^Paketmu telah berhasil diantar oleh Hero(?:\s+.+)?[.!]?$/i.test(wording)) {
    return { description: 'Paketmu telah berhasil diantar oleh Hero', stage: 'delivered' };
  }
  if (/^Yay! Hero(?:\s+.+)? sudah sampai di tujuanmu[.!]?$/i.test(wording)) {
    return { description: 'Yay! Hero sudah sampai di tujuanmu', stage: 'out_for_delivery' };
  }
  if (/^Hore! Hero sedang otw antar paket ke tujuanmu!$/i.test(wording)) {
    return { description: 'Hore! Hero sedang otw antar paket ke tujuanmu!', stage: 'out_for_delivery' };
  }
  if (/^Paketmu sudah sampai di lokasi transit\. Sebentar lagi akan diantar oleh Hero kami!$/i.test(wording)) {
    return { description: 'Paketmu sudah sampai di lokasi transit. Sebentar lagi akan diantar oleh Hero kami!', stage: 'in_transit' };
  }
  if (/^Paketmu sedang dalam perjalanan ke lokasi transit selanjutnya!$/i.test(wording)) {
    return { description: 'Paketmu sedang dalam perjalanan ke lokasi transit selanjutnya!', stage: 'in_transit' };
  }
  if (/^Paketmu sedang transit\. Sabar ya, paketmu akan segera dikirimkan ke tujuan berikutnya[.!]?$/i.test(wording)) {
    return { description: 'Paketmu sedang transit. Sabar ya, paketmu akan segera dikirimkan ke tujuan berikutnya', stage: 'in_transit' };
  }
  // Explicit nonmovement stops the facade's generic unresolved-event transit fallback.
  if (/^Hero akan mengantar paketmu!$/i.test(wording)) {
    return { description: 'Hero akan mengantar paketmu!', stage: 'pending' };
  }
  return { description: 'Tracking update' };
}

/** The map reads the wording the parser keeps for a scan. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => paxelScan(wording).stage,
  gaps: [],
};
