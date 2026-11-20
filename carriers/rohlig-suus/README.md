# Rohlig SUUS Logistics

Rohlig Suus Logistics S.A., of Warsaw, is a Polish logistics operator: a domestic groupage and
pallet network, full loads, sea and air forwarding, contract logistics and deliveries for online
shops. It is a different company from Röhlig Logistics of Bremen (`rohlig`), with its own tracker
and numbers.

## How it works

1. `trawl`: the browser service opens the guest order page,
   `portal.suus.com/order-details/<number>`. The page gets its own invisible reCAPTCHA Enterprise
   token and sends it in a `recaptcha-token` header with
   `GET /api/parcel/guest/tracking/orders?parcelNumber=<number>&locale=en`. The service's
   [helper](../../trawl/rohlig-suus-browser.mjs) captures that request alone and passes on the
   order's status, planned delivery day, destination country and events.

- The tracker takes the number without spaces; a space makes it refuse the request.
- A known number answers with its order. One the tracker does not know answers HTTP 204 with
  nothing, which is not found. A missing or refused token answers HTTP 500 with nothing, which is
  a challenge.
- The reply must name the number asked.

## Notes

- Events carry only a numeric id. Their English wording and stage come from the tracker's public
  dictionary (`/api/parcel/guest/tracking/visibility-events/entries`), kept in `statuses.json`.
  Ids the dictionary hides from guests are dropped, as the page drops them. The page shows the
  note of the planned-delivery notice alone; the consignee's note names a person and is not read.
- Billing, booking and estimate events follow the journey without moving the parcel, so they have
  no stage and do not decide the status.
- Event times are wall clocks without a zone. They stay in `local_time`.
- Depot codes become towns by the tracker's public locations dictionary; an unknown code gives no
  location.

## Limitations

- No delivery time, signatory, proof of delivery or sender. The order's weight, volume, item count,
  reference and addresses are not read.

## Numbers

Customers give numbers of four letters and nine digits. Too few have been seen to settle a rule,
so detection does not offer Rohlig SUUS.

## Links

`portal.suus.com/order-details/<number>` opens one parcel, and the library reads the number from
that address.

## Testing

```sh
FLARESOLVERR_URL=http://127.0.0.1:8191 npx vitest run --config vitest.carriers-live.config.ts carriers/rohlig-suus/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json` through the browser service at
`FLARESOLVERR_URL`; `ROHLIG_SUUS_TRACKING_NUMBER` tracks another shipment.
