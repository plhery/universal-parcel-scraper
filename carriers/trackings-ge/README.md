# Trackings.GE

Trackings.GE is a Tbilisi courier that delivers across Georgia and runs pickup points. Among its
clients is Ozon, whose orders to Georgia it delivers. The adapter looks up one tracking code on
the public tracker at trackings.ge, over plain HTTP.

## How it works

1. `direct`: `GET https://trackings.ge/en/track` for the tracker's session cookie and the form
   token in its `csrf-token` meta tag, then `POST` to the same address with `track_num={number}`
   and the token in `X-CSRF-TOKEN`, as the page's script does once it loads. The reply is JSON
   served as `text/html`: the parcel's records in `data`, the history rows the page shows as
   HTML in `tracking_tree`, and the status line above them in `track_status_smg`.

The API in Trackings.GE's developer documentation needs an account's bearer token, so the
adapter reads the public tracker instead.

## Notes

- The reply's `source` names where Trackings.GE holds the record. With `ozon`, the parcel is an
  order of its client Ozon, which the page names as the parcel's owner with Ozon's logo:
  Trackings.GE delivers it in Georgia, and the records name Trackings.GE's number beside Ozon's
  posting number. The records and rows are Trackings.GE's own steps for that delivery, so the
  adapter reads them as Trackings.GE's scans and names no other carrier.
- Every record must name the number asked, as Trackings.GE's number or the client's; an answer
  with a record for another number is inconclusive.
- Each record has a numeric status code and a wall clock to the second. The page words only the
  codes it knows, shows each such record as a row under its date alone, and leaves the others
  out. The events are the page's rows in its English wording. A row takes its record's clock and
  code when its day has as many records as rows; several rows of one day pair with their records
  only when the page's dates show its order. Otherwise the row keeps its date. A record the page
  does not show has no wording and is left out; records without any row are an answer without
  history for a number the carrier knows.
- The clocks carry no offset and stay `local_time`. A date the page prints in another form stays
  as text.
- Rows are read in the order of the reply's records, oldest first, unless the page's dates show
  the newest first, and are then sorted newest first with rows of one day in that order.
- The stage is the newest row's with a stage, by Trackings.GE's wording and then the shared
  wording rules, else the status line's. The status line is the result's status text.
- The tracker's own "not found" answer, `err_msg` `no_such_track`, is not found. A page instead
  of JSON, a reply without records, a block page, a missing page or an expired form (HTTP 419)
  is never not found, and HTTP 429 stays a rate limit.
- The tracker takes many seconds over each lookup, found or not, so the adapter makes one read
  with the whole budget rather than splitting it for a retry.
- The client's posting number, the order and person ids and the pickup point's address are left
  out.

## Limitations

- The page renders orders booked on Trackings.GE itself (`source` `trackings.ge`) from another
  layout, not seen in a reply yet. The adapter fails such a reply as a schema error.
- The tracker also finds an Ozon order by Ozon's posting number with its dashes. Normalized
  numbers lose the dashes, so only Trackings.GE's number is looked up.
- No location, estimate, weight or instant.

## Numbers

The examples in its developer documentation are fifteen digits, as is the number on Ozon's
orders. Fifteen digits are a shape many carriers print, so no rule claims them and Trackings.GE
is selected explicitly. The samples are in [`numbers.json`](numbers.json).

## Links

`trackings.ge/en/track?track_num=<number>` looks one number up (also under `/ka/` and `/ru/`), and
the library reads the number from that address.

## Testing

`TRACKINGS_GE_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/trackings-ge`, with the
number set outside the repository. `TRACKINGS_GE_UNKNOWN_NUMBER` adds a check of a made-up
number.
