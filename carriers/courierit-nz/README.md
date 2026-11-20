# Courierit New Zealand

[Courierit](https://www.courierit.co.nz/) books domestic parcel and freight services in New Zealand and tracks consignments on its Freight Gateway. Select **Courierit New Zealand** and use the 12-digit consignment reference from the booking or tracking link.

## How it works

The adapter loads `/Order/View?consignmentRef=…` and confirms the consignment heading. It then makes the same empty-body POST as the booking page to `/Order/OrderViewWithLatestStatus` with the exact reference. Both requests run without an account. The current status and earlier scans come from the returned status fragment. The adapter keeps delivery and scan times as local clocks because the fragment supplies no offset or scan location. The booking page's personal data and delivery documents are left out.

The gateway presents a current status separately from its history. A consignment can show a later `InTransit` summary after an older `Delivered` row. The adapter preserves both carrier statements. A gateway error without a shipment record remains a fetch or schema error.

## Testing

`COURIERIT_NZ_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/courierit-nz`
