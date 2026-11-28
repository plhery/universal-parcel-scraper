# eCourier UK

eCourier, a Royal Mail company, is a London same-day courier that collects and delivers parcels and
documents within hours, including medical deliveries, and passes some jobs on to other carriers. Its
site is ecourier.co.uk. The `ecourier` entry is an unrelated courier in Bangladesh. Select the carrier
explicitly.

## How it works

1. `direct`: one `POST https://www.ecourier.co.uk/json/search/trackingdownload` with the number as
   `consign_note`, the search its tracking page makes, without a login, cookie, CAPTCHA or browser.

The site runs Courier Navigator's tracking search itself, with the same scripts as
[UBX UK's](../ubx-uk/README.md) tracker, and the adapter shares its reader and status ids: the job must carry
the number asked, an empty job list is read as not found, events keep their wall clocks and are staged by
their status id, and a job passed on to another carrier hands on its forwarding reference and, when the
reference has that carrier's shape, names it.

## Notes

- The page adds `jobid` when it refreshes a job it already shows; a first search sends the number alone.

## Limitations

- No found reply has been seen, so the fixtures are synthetic, shaped as the page's scripts read the reply.
- A job number a customer gave in a review got an empty list, so the job number a customer sees may not be
  what the tracker searches.
- Numbers reach the adapter without hyphens, so a job reference printed with one, as in the page's EC-123456,
  is searched without it.

## Numbers

Its tracking guide gives eight-digit consignment numbers, which its FAQ calls docket references, and its
tracking page says a job reference typically begins with the account's prefix, as in EC-123456. Eight digits
are a shape other carriers' rules read, and no public number is known, so there is no rule.

## Links

Tracking links carry the number as `consign_note` on the tracking page.

## Testing

Set `ECOURIER_UK_TRACKING_NUMBER` and optionally `ECOURIER_UK_UNKNOWN_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/ecourier-uk`.
