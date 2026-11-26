import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { delyvaStatusMap } from './delyvaStatus.js';

// BabyXpress scans with the status codes of the Delyva platform it runs on.
export const statusMap: CarrierStatusMap = delyvaStatusMap;
