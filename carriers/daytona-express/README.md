# Daytona Express

Daytona Express is a Brazilian express courier based in Joinville, with its own bases and
agents across the country. The adapter tracks its protocols (HAWB), from the pickup request to
the delivery, through the tracker its site's tracking form opens.

## How it works

1. `direct`: `GET daytonaonline.daytonaexpress.com.br/Conhecimento_daytona/Index?txtcto=<protocol>`,
   the server-rendered page the form opens, with no session or CAPTCHA. A request that fails to
   reach the tracker or times out gets one `retry`.

## Notes

- The protocol is nine digits; customers also quote it as `HAWB - <protocol>`, which the
  adapter accepts.
- The page names the protocol it answers for, and the adapter checks it: the tracker also finds
  a shipment by its invoice number, which other senders reuse.
- The not-found page writes the number looked up back into its search field; it reads as not
  found only when that is the protocol asked.
- Scans give a date and a minute at the base, without a zone, so events keep `local_time`.
- `AUSENTE` follows a delivery round and reads as a failed attempt.

## Limitations

- The name of whoever signed for the parcel is not kept.
- The page shows no weight, delivery estimate or addresses.
- Lookups by invoice number, which the tracker also takes, are not supported.

## Testing

`DAYTONA_EXPRESS_TRACKING_NUMBER=<protocol> DAYTONA_EXPRESS_UNKNOWN_NUMBER=<invented protocol> npm run test:carriers:live -- carriers/daytona-express`
