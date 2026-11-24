# CODExpress

CODExpress (CODEX, Couriers On Demand Express Pty Ltd) is an Australian courier for same-day and
next-day parcels, with CBD delivery in Sydney and Melbourne. Its site is codexpress.com.au. Its
tracker runs on Locate2u, a multi-tenant delivery platform, at `cbd-tracking.locate2u.com`: a page
of CODExpress's own that relays each lookup to its Locate2u account.

## How it works

1. `direct`: posts `{"tracking_id": <barcode>}` as JSON to `cbd-tracking.locate2u.com/api/track`,
   as the tracking page's script does. The reply lists the parcel's Locate2u statuses, oldest
   first, each with its time.
2. `retry`: a read that fails to reach the tracker, or hangs, is made once more. The first try gets
   half of the budget.

- No session, token or CAPTCHA.
- The host answers for CODExpress's account only, so a barcode another Locate2u customer issued is
  unknown to it.
- A barcode the account does not hold gets HTTP 404 and "Tracking ID is invalid. Please use the
  barcode.", read as not found. The reply does not repeat the barcode; the request for it does.
  Another refusal leaves the answer open; a block page is a challenge, a redirect or a 404 without
  the tracker's JSON a moved tracker, and a reply of another shape a changed one.

## Notes

- Each status is kept as the scan's code and sets its stage. Its wording is the one the tracking
  page's script shows; a status the script does not word is shown as it comes and staged by the
  shared wording rules.
- Times end in `Z`, but they are wall clocks: the page formats them in UTC to show their digits as
  they come, and read as instants the samples' deliveries would fall in the middle of the Sydney
  night. They are kept in `local_time`, without an offset.
- The reply carries a live-tracking link while a driver has the parcel. It opens the driver's
  position on a map and is never read.

## Limitations

- Statuses carry no place, and the reply gives no estimate, service, weight or delivery proof.
- The map holds the three statuses the page's script words; Locate2u has others.

## Numbers

CODExpress labels carry CODE and digits. The adapter takes 6 to 40 letters and digits with at least
one digit, in capitals, since the tracker looks up any barcode the account holds. Detection has no
rule for the shape. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker reads the barcode from its field and opens no per-parcel page, so no link opens one
parcel.

## Testing

`npm run test:carriers:live -- carriers/codexpress`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`CODEXPRESS_TRACKING_NUMBER` tracks another barcode, and `CODEXPRESS_UNKNOWN_NUMBER` another unknown
one.
