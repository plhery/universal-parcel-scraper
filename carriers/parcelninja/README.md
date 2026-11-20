# Parcelninja

Parcelninja operates a South African e-commerce fulfillment and delivery network. Its [public tracker](https://store.parcelninja.com/tracking.aspx) accepts the waybill number without a session.

The `direct` step sends the number as `WaybillNo`, verifies the waybill in the result heading, and reads the dated scan rows. The tracker shows local clocks in a 12-hour format. The adapter preserves the reported seconds and the separate scans at different times. It leaves the signer and contact details out of the result.

Parcelninja's waybill history can include scans relayed by the delivery partner.

## Testing

Run `npm exec vitest -- run carriers/parcelninja/adapter.test.ts`. Set `PARCELNINJA_NUMBER` and run `npm run test:carriers:live -- carriers/parcelninja` for the native check.
