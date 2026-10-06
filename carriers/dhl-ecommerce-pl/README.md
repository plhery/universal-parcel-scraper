# DHL eCommerce Poland

DHL's domestic parcel network in Poland, formerly DHL Parcel Polska, through
the guest lookup of its consumer portal. German DHL Paket is
[dhl](../dhl/README.md) and the Benelux network is
[dhl-ecommerce-nl](../dhl-ecommerce-nl/README.md).

## How it works

1. `direct`: `GET mojdhl.pl/api/dhl/public/auth/captcha/challenge`, then
   `POST …/shipment/status` with the number and the solved challenge, the two
   requests `mojdhl.pl/tracking` makes for a visitor who is not signed in. The
   answer is one entry for the number with the current status of its shipment.
   An entry without a number type and without a shipment is the only answer
   read as a missing parcel.

## Notes

- The portal gives the current status and no scan history, so the result is a
  summary without events. It carries a time only for a delivery, the one
  status the portal times.
- The national page with the full history, `sprawdz.dhl.com.pl`, sits behind a
  reCAPTCHA and is not used.
- The challenge is a proof of work the page computes on its own for every
  visitor: a number below a stated limit whose SHA-256 with a salt matches. It
  is solved once per lookup, inside the lookup's budget. A proof the portal
  refuses is an inconclusive answer.
- The answer names the sender. That name is discarded, with the waybill alias
  and the self-service links.
- A code in [statuses.json](statuses.json) has the meaning the page script or
  a live answer gives it. Any other code takes the stage of the timeline step
  sent with it.
- The portal recognizes Allegro Delivery numbers and sends their owner to
  Allegro. The adapter refuses `AD` numbers and leaves them to Allegro.
- The posting date is local midnight written in UTC. It is a day and is not
  emitted as a scan time.
- An answer with several shipments under one number is inconclusive: nothing
  says which one was asked for.

## Limitations

- No history and no location. Detection suggests the carrier for eleven-digit
  waybills only, a shape other carriers share.
- German DHL Paket shapes, `JJD` licence plates included, are detected as DHL.
  They are read here only when the carrier is named.

## Testing

`npm run test:carriers:live -- carriers/dhl-ecommerce-pl` checks that a
synthetic number gets a clean not-found. Set
`DHL_ECOMMERCE_PL_TRACKING_NUMBER` outside the repository to read a real parcel.
