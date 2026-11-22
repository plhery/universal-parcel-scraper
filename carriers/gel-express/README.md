# GEL Express

GEL Express is a German express parcel network. Tracked through its own tracking page on
gel-express.de.

## How it works

1. `direct`: one `GET https://www.gel-express.de/de/sendungsverfolgung/?snr={number}`, as GEL's
   header search opens it. It needs no cookie, token, key or browser. The server renders the
   shipment, its current status and when that status was set.
2. `retry`: a lookup that fails to reach the page, or hangs, is sent once more within the budget.
   The first try gets half of the budget.

- An unknown number is HTTP 200 with `Ihre Sendungsnummer konnte leider nicht gefunden werden`,
  which is not found when the notice's search field holds the number asked. A 404 or a redirect
  is a moved route.
- The page's heading and its postcode form must hold the whole number asked. Anything else is
  inconclusive.
- Cloudflare fronts the site. A browser check is a challenge; the tracking form's POST gets one
  outside a browser, the page's GET has not.
- There is no recognition: no detection rule offers GEL for a number, so preflight never asks it.

## Notes

- The number alone shows the current status only. Earlier steps are icons on a progress rail
  without times, which the adapter does not read. The recipient's postcode opens more details and
  the safe-drop permission; the adapter does not ask for it.
- The status time is a wall clock without a zone, read in Europe/Berlin.
- The status carries wording only. The map holds the progress rail's steps and the wordings of
  the former tracker; only a delivery has been seen as a current status.
- The page also shows the shipper's reference, the ship date and the piece count, which are left
  out.

## Limitations

- No history, scan locations, delivery estimate, weight, sender or recipient.

## Numbers

A GEL Sendungsnummer has ten digits, as GEL's barcoding guide states and its tracker shows. A
return gets a number of its own, which the former tracker listed under the outbound parcel. Ten
bare digits are printed by many carriers, so no rule claims them. The samples and their sources
are in [`numbers.json`](numbers.json).

## Links

The [tracking form](https://www.gel-express.de/de/sendungsverfolgung/) posts `snr` to
`/de/sendungsverfolgung`. Its header search opens `gel-express.de/sendungsverfolgung/?snr={number}`,
which redirects to the `/de/` page. The former tracker, run by GEL's IT provider, read the number
from `sean` on `thalmaier.de/gelsend/suche.php`.

## Testing

`npm run test:carriers:live -- carriers/gel-express`, with `GEL_EXPRESS_TRACKING_NUMBER` and
optionally `GEL_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
