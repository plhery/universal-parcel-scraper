# Celero

Celero is a Mauritian freight forwarder, shipping agent and express courier that also works in
Madagascar. It clears parcels from online shops into Mauritius. The adapter reads the service
behind its tracking form over plain HTTP.

## Numbers

A Temu parcel into Mauritius carried an air waybill of MU and twelve digits, the shape Speedaf's
Mauritian numbers have, so detection offers Speedaf and not Celero. The tracker takes up to fifty
numbers at once and matches each whole.

## How it works

1. `direct`: posts `{"awbs":[number]}` to `sigma.mu/tracking/track_api.php`, which the vendor of
   Celero's ERP runs. The form on Celero's home page carries a Cloudflare Turnstile widget, but its
   script posts the numbers without the widget's token, and the service asks for none.

The reply maps each number to its scans, newest first: a record number, the number, a wall
clock, a status in capitals, a fault and a remark. A number Celero does not know maps to an empty
list.

## Notes

- Scans keep their wall clock in `local_time`, without a zone. A clock at midnight exactly, as
  the customs clearance has, is the scan's day alone.
- Scans are ordered by their record numbers, the order Celero wrote them in, so a scan dated by
  its day stays above the earlier ones.
- A fault or remark in words is added to the status. A bare reference, such as the customs
  declaration's, and a remark repeating the status are left out.
- Statuses the map does not record go through the shared wording rules.

## Limitations

Only the manifest and the clearance have been seen. The delivery and its proof are not shown.

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/celero/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json`; `CELERO_TRACKING_NUMBER` and
`CELERO_UNKNOWN_NUMBER` track other numbers.
