# Ural Express

Ural Express (URAL) is a Chinese cross-border logistics company shipping marketplace parcels and freight to
Russia and Israel. Its site is uralsvip.com, and its tracker runs on a TMS hosted by iLine Express. Tracked
through the service its tracking page asks.

## How it works

1. `direct`: `POST https://cl.ilinexpress.com/express/track/ilinePage/trackByWaybillNums` with a JSON
   list holding the number, as the tracking page at tmsplus.ilinexpress.com does. It needs no session,
   token, CAPTCHA or browser.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the budget.

- The reply lists one shipment for each number Ural Express holds, under `waybillNum`, which must be
  the whole number asked, with its rows. A row naming another number makes the reply inconclusive.
- A number it holds nothing under is left out of the list. An empty list is the tracker's only answer
  for it, so it stays inconclusive with the reason `portal_not_found`.
- A shipment listed without rows is no history with the reason `listed`. Older parcels come back
  this way.
- A reply code other than 200 is inconclusive, or rate-limited when its message says the calls are
  too frequent. A redirect or a 404 is a moved route, HTTP 403 or a browser check is a challenge, and
  a reply that is not the expected JSON is a schema failure.

## Notes

- The page shows each row's clock and wording. The rows also carry a TMS status code and a country
  code, which become `provider_code` and the location; the destination country comes from the rows.
- Rows are wall clocks without a zone, on more than one clock: the TMS's first row in China and the
  first row relayed from the Russian last mile are five hours apart for the same moment. Each row
  keeps its `local_time`, and the parcel is ordered by them as the page orders it.
- The relayed rows come without a code or a country and are staged by their whole wording.
  "ID data collected" is not staged: it records the recipient's customs data, not a move.
- Each shipment carries the marketplace's order number. It is never read.

## Numbers

GdePosylka's archived pages show Ural Express numbers as URA, eight digits and ZPRU. The adapter takes
URA, eight digits and two to four letters. No rule offers Ural Express yet. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

`npm run test:carriers:live -- carriers/ural-express` looks up the first public sample, or
`URAL_EXPRESS_TRACKING_NUMBER` when set, and an invented number, or `URAL_EXPRESS_UNKNOWN_NUMBER`.
