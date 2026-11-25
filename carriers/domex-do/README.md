# Domex Expreso

Domex Expreso is a Dominican courier with more than seventy offices and lockers. It also receives
purchases at addresses in Miami and Madrid. It is a different company from Sri Lanka's
[Domex](../domex/README.md).

## Numbers

Its tracker takes a Domex guide, WX and twelve digits, or the shop's tracking number. The adapter
takes only the Domex guide: a shop's number can lead to a guide under another number, and an answer
must name the number asked. Detection offers no carrier for the guide's shape.

## Retrieval

`direct` opens `domex-online.iplus.com.do/lg-es/ut/Estatus.aspx?id=<guide>`, the status page of the
iPlus courier platform that also serves [domex.do](https://domex.do/rastreo). The page needs no
session, key or CAPTCHA. The adapter reads the guide the page displays and its dated scan table,
newest first; it skips the progress bar, which lags the scans.

- The page's `Tracking inválido` notice for the number is read as not found. iPlus drops old guides,
  so a guide from an earlier year can get the same notice.
- An empty form without a notice leaves the answer open; a page for another guide is a changed
  reply, and a block page a challenge.

BM Cargo, Tupaq, Aeropaq and Caribe Pack run on the same platform.

## Status

The scans have Spanish wordings and, for most, the branch or warehouse. Receipt in Miami is accepted,
the customs scan is customs, the hand-over at the counter is delivered, and `Disponible` with its
repeated day reminders (`Disponible (D03)`) is ready for pickup. Billing and payment scans get no
stage.

## Clocks

The scans have a wall clock without an offset, from Miami and the Dominican Republic, so they keep
it as local time.

## Links

`domex.do/rastreo?guia=<number>` and the iPlus page's `?id=<number>` look one number up, and the
library reads the number from either address.

## Limitations

- Weight, charges and the invoice need the customer's account; the public page has none of them.

## Testing

`DOMEX_DO_TRACKING_NUMBER=… DOMEX_DO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/domex-do`
