# COPE Sensitive Freight

COPE Sensitive Freight (Janala Pty Limited) is an Australian road carrier for fragile and
high-value goods with a national depot network. Its site is cope.com.au.

## How it works

1. `direct`: posts the number as `consignment_code`, with `action=get_consignment`, to
   `www.cope.com.au/wp-admin/admin-ajax.php`, as the site's "Consignment Tracking" pop-up does. The
   theme's action relays the page of COPE's eSmart system for the number: a head with the number,
   the day it was added, the service, the delivery estimate and the current stage, then a row per
   event with its time, suburb and state, activity and stage.
2. `retry`: a read that fails to reach the site, or hangs, is made once more.

- No session, token or CAPTCHA.
- A number eSmart does not hold gets the same page with every field empty and no row. The site's
  script shows that page as "No data found for this tracking number", and the adapter reads it as
  not found. An empty or different page, a block page or an HTTP error is never not found.
- The head must name the number asked.

## Notes

- Each row's stage column is its code and sets its stage; a code the map does not know goes
  through the shared wording rules on the activity. An activity that names who took the goods or
  holds a phone number is left out.
- Rows keep their wall clock: the page gives no zone, and COPE's depots span Australia's zones.
- The estimate is kept until the consignment is delivered, unless its day is behind the newest row.
  The day the job was added and the estimated number of days are left out.
- eSmart matches the whole number in capitals, so the adapter sends it that way.

## Limitations

- Only some rows name a place.
- No public page lists eSmart's stages: one missing from [`statuses.json`](statuses.json) is read by
  its wording.
- eSmart forgets old consignments: notes from years ago get the empty page.

## Numbers

A consignment number is the sending customer's letter code, then its counter. The code belongs to
the customer, and the shape is common, so there is no detection rule. The samples and their sources
are in [`numbers.json`](numbers.json).

## Links

The tracker reads numbers from its pop-up and opens no per-consignment page, so the catalog sends
people to the homepage.

## Testing

`npm run test:carriers:live -- carriers/cope-sensitive-freight`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`COPE_TRACKING_NUMBER` tracks another number, and `COPE_UNKNOWN_NUMBER` another unknown one.
