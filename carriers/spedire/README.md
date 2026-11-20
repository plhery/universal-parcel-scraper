# Spedire

spedire by alsendo is an Italian parcel broker: it books parcels with partner couriers, under its
own SPEDIRE PRIORITY service among others, and its spedire pro platform does the same for
businesses. Its tracker takes Spedire's shipment reference or the courier's label number.

## How it works

1. `direct`: posts `{"code": …}` to `www.spedirepro.com/api/public/tracking`, then, when that
   platform has no such shipment, to `www.spedire.com/api/public/tracking`, in the order the
   tracker page at `spedire.com/tracking/{code}` asks them. `{"success":false}` from both is not
   found.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more.

- Cloudflare challenges the tracker's pages but not these lookups, which answer without a session.
- A reply must name the code as its reference or its label number.

## Notes

- The shipment's status letter leads, as the page heads its steps with it. The page's own script
  gives each letter's sentence, which the adapter passes on as the status text; `X` with
  exception code 5 is the page's missed delivery that the courier tries again the next day.
- The rows are Spedire's and the courier's, relayed in Italian. They are staged by the shared
  wording rules and keep their Italian wall clock: the reply gives no zone.
- The courier's label number is passed on as `delivery_tracking_number` when the code was the
  reference. The reply names the courier only by Spedire's own service, so no `delivery_carrier`.
- Names, cities, postcodes, the sender's country and pickup bookings are left out.

## Limitations

- No delivery estimate or proof of delivery.
- A challenge on the lookups themselves is not recovered in a browser.

## Numbers

A shipment reference is OE and eleven digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/spedire`

The live test tracks the public sample in `numbers.json`; `SPEDIRE_TRACKING_NUMBER` tracks another
code, and `SPEDIRE_UNKNOWN_NUMBER` checks the not-found answer.
