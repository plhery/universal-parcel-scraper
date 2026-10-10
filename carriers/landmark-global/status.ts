import type { ClassifiedStatus } from '../../core/status/index.js';

const WORDINGS = new Map<string, ClassifiedStatus>([
  ['Delivered', { status: 'delivered', stage: 'delivered' }],
  ['Delivered - Delivery / deposit with non-recurring authority', { status: 'delivered', stage: 'delivered' }],
  ['Delivered to your community mailbox, parcel locker or apt./condo mailbox', { status: 'delivered', stage: 'delivered' }],
  ...['Onboard for delivery', 'Item out for delivery', 'Out for Delivery'].map(wording => [wording, { status: 'out_for_delivery', stage: 'out_for_delivery' }] as [string, ClassifiedStatus]),
  ['Shipment Data Uploaded', { status: 'pending', stage: 'registered' }],
  ['Item arrival at collection point for pick-up', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['Transmitted customs information', { status: 'in_transit', stage: 'customs' }],
  ...['Customs cleared', 'Item processed at facility', 'Item processed', 'Received in destination country',
    'Crossing border and in transit to carrier hub', 'Scanned at Landmark crossdock facility', 'Processed',
    'Shipment received at originating postal facility', 'Departure to country of destination', 'Shipment has arrived at depot',
    'Received at international processing center', 'Incoming scan at facility', 'Shipment has departed from airport',
    'Shipment has departed from depot',
    // A delivery partner's hub after Landmark's export, not the parcel's acceptance.
    'Parcel received at HUB', 'Received at Hermes hub',
    // Evri's depot handing the parcel to its courier, who confirms receipt before delivering.
    'Out For Delivery To Courier'].map(wording => [wording, { status: 'in_transit', stage: 'in_transit' }] as [string, ClassifiedStatus]),
]);

export function landmarkStatus(wording: string): ClassifiedStatus | undefined { return WORDINGS.get(wording); }
