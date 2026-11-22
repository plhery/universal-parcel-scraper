# Overseas Express

Overseas Express is a Croatian parcel carrier. Its tracker, I-NET on `inet.overseas.hr`, is Aras
Kargo's platform.

## How it works

The adapter does what I-NET's guest tracking page does, over plain HTTP and without a login. It
posts `{"Platform":201,"Reference":"{number}"}` to
`inetapi.overseas.hr/NesyIntegration/GetGuestShipmentDetails` with `Accept-Language: en-US`, and
reads the shipment's scans. A fourteen-digit shipment number goes as `ExternalId` first, then as
`Reference`, as on the page. Without a language the service writes each scan's code where its
wording belongs.

The scans carry UTC instants and the hub that made them. Each has the former system's four-letter
code beside I-NET's own scan type; the status map reads the code first, then the scan type, then the
English wording. The reply names the shipment number and the parcel number, which bind it to the
number asked.

## Numbers

Customers enter the eight-digit parcel code. The whole parcel number reads as three digits, three
digits, those eight digits and two more, and the lookup takes it too, as it takes the shipment
number. Eight digits are shared with other carriers, so no rule claims them.

## Limitations

- An unknown code is a `resultCode` 400 inside an HTTP 200; any other refusal is reported as
  indeterminate.
- The lookup has no history for the older archived samples in `numbers.json`.
- Both hosts sit behind an Azure application gateway that refuses some addresses with HTTP 403, a
  real browser on them included, and answers others over plain HTTP. A refusal is a transport
  failure, never a missing parcel.
- The reply's sender and recipient come masked; the adapter keeps neither, nor the parcel shop's
  address or the delivery coordinates.

## Links

The header form on `www.overseas.hr` sends the number as `trackingid` to `inet.overseas.hr/auth`.
Archived lookups use `is.overseas.hr/tracking/?trackingid={number}`, which forwards there,
`is.overseas.hr/track-and-trace/{number}` and, on the former site,
`www.overseas.hr/Tracking/Package/{number}`. The gateway refuses some addresses, so the catalog has
no parcel link.

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/overseas-express
```

`OVERSEAS_EXPRESS_TRACKING_NUMBER` overrides the public sample. From an address the gateway
refuses, GitHub's runners among them, the tests skip.
