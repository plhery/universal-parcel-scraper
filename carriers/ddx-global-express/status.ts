import type { Stage } from '../../core/status/index.js';

export const statuses = new Map<string, { label: string; stage?: Stage }>([
  ['PENDING', { label: 'Đang chờ cập nhật', stage: 'pending' }],
  ['INFO_RECEIVED', { label: 'Đã tiếp nhận thông tin', stage: 'registered' }],
  ['IN_TRANSIT', { label: 'Đang vận chuyển', stage: 'in_transit' }],
  ['OUT_FOR_DELIVERY', { label: 'Đang giao hàng', stage: 'out_for_delivery' }],
  ['DELIVERED', { label: 'Đã giao hàng', stage: 'delivered' }],
  ['EXCEPTION', { label: 'Có sự cố vận chuyển', stage: 'exception' }],
  ['EXPIRED', { label: 'Đã hết hạn' }],
]);
