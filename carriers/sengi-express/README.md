# Sengi Express

Sengi Express (Seng Yi (Shenzhen) Global Supply Chain Management) is a Chinese cross-border
forwarder controlled by Poste Italiane. It carries parcels from China to Italy and other European
countries, where Poste Italiane or the destination's post delivers them. Its site is
sengiexpress.com. Tracked through the tracker on its portal.

## How it works

1. `direct`: the tracker at portal.sengiexpress.com, a POST of
   `{"trackingNumberList": [number], "type": 1}` to `api-v2/tracking/web` without a session,
   cookie or CAPTCHA.
2. `retry`: the same request once more after a network failure.

- The reply is an object keyed by each number the tracker holds, its rows oldest first, or an
  empty object, which is not found. A key or row naming another parcel is a schema error.
- A page in place of the JSON that reads as a bot check is a challenge, whatever its HTTP status;
  another page is a schema error, and HTTP 429 a rate limit.
- Recognition makes the same request and asks only about SDA waybills (below).

## Notes

- Each row has an English and a Chinese wording, an event code, a wall clock and the UTC offset
  in hours that the tracker shows beside it (`GMT+1`). The scans keep that offset; a row without
  one keeps its wall clock.
- The place is the arrival airport's code, or `-` for none.
- The rows hold Sengi's own leg: the order data, the arrival airport, import clearance and the
  handover to the last mile. Rows on Sengi's line to Poste Italiane (channel `PI`) name Poste
  Italiane as the delivery partner, under the same number or the one Sengi relabels the parcel
  with, so the consumer can follow the last mile there.
- The order number beside each row is the shop's and is left out.
- The tracker holds Sengi's consignments only. For a parcel with a Poste code it gives the line's
  channel and Cainiao's advance notice to the last mile, which
  [AliExpress / Cainiao](../aliexpress/README.md) already gives as the earlier leg (see
  [Poste Italiane](../poste-italiane/README.md)).

## Limitations

- The reply has no estimate and no delivery: the last mile is Poste Italiane's or the
  destination post's.

## Numbers

Parcels for Malta carry five letters, nine digits and `MT`. ParcelsApp names
[MaltaPost](../maltapost/README.md) beside Sengi for one and relays MaltaPost's scans, so the
rule is low confidence and shared with MaltaPost, the carrier recognition asks about it. Parcels
for Italy are tracked under Poste Italiane's codes, which its own rules cover. Sengi's tracker
answers those codes too, so when an aggregator names Sengi beside a code Poste's rule claims at
high confidence, the hint goes to Poste Italiane (`core/catalog/partners.ts`).

Other parcels for Italy carry an SDA waybill: three digits, `C`, eight digits and `F`. Until SDA
takes the parcel only Sengi's tracker knows it, and universal providers relay its rows under
Sengi's name. The waybill is SDA's and AliExpress shows its buyers SDA waybills too, so the rule
is low confidence beside Poste Italiane's and AliExpress's. Recognition asks Sengi about this
shape only: its tracker holds the parcels Sengi carries, so a waybill it knows is Sengi's.

## Links

The tracker reads numbers from a form and opens no per-number page, so the catalog sends people
to it.

## Testing

```sh
SENGI_EXPRESS_TRACKING_NUMBER=... SENGI_EXPRESS_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/sengi-express
```

Fixtures are synthetic ([fixtures/README.md](fixtures/README.md)).
