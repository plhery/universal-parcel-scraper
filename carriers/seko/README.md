# SEKO Logistics

SEKO Logistics is a forwarder and freight carrier headquartered near Chicago. Its North
American network picks up, moves and delivers freight and large parcels, and its forwarding
arm books air and ocean shipments. Tracked through its tracking page, which SEKO's server
renders, and OmniParcel's GX parcel numbers, which that page does not know, through the
OmniParcel tracker, which its server renders too.

## How it works

1. `direct`: one `GET https://www.sekologistics.com/en/track/?trackingNumbers={number}`, the
   page SEKO's tracking form opens. It needs no cookie, token, key or browser. The page shows
   the shipment's summary, a step rail and its milestones, or a line saying it found nothing for
   the number. A GX number, GX and 17 or 18 digits, is asked of
   `https://track.omniparcel.com/?Id={number}&timezoneId=91` instead: the parcel's headings, a
   step rail, its scans and a summary, or the tracker's search form when it knows none.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget.

- The shipment must show the number asked; a page for several numbers shows each in turn. An
  OmniParcel page must name it in its heading and its form.
- A missing page or a redirect is a moved route. The hosting's page for a stopped site, an HTTP
  403, is maintenance: SEKO's former tracking lookup on `mysekoapi.sekologistics.io` answers it.
- Cloudflare's browser check is reported as a challenge.
- Recognition makes the same request.

## Notes

- A milestone's date and time are SEKO's wall clock to the minute, with no zone. The delivery's
  milestone runs one or two hours off the proof of delivery's clock at the address, so the
  clocks are not the scanning place's either, and they stay `local_time`.
- Most milestones say `Status Changed to [X]`, naming one of SEKO's statuses. The newest staged
  milestone is the current stage. The step rail is not read: the milestones name each status it
  shows, and holds besides.
- The history repeats some status changes within a minute, sometimes in another case; the
  copies are merged. Proof-of-delivery filing rows and a booked return move nothing and are
  dropped or left without a stage.
- The page gives an expected day or a delivery window. Its weight has no unit and is not kept.
- The origin and destination addresses, postcodes, references, piece count, proof-of-delivery
  time and signer are not kept. The destination's country code is. The milestones name no
  location.
- OmniParcel's scans give a day heading, a 12-hour time and, before the last mile, a place.
  `timezoneId=91` is the tracker's id for UTC, so the clocks are instants; the page must show
  it selected. The tracker's default, "(UTC+10:00) Canberra, Melbourne, Sydney", stays +10:00
  all year, without Sydney's daylight saving, and ParcelsApp's copies of the scans have its
  digits (`clock.ts`). Its delivery heading runs on another
  clock than the scans and is not read. Its scans are staged by the wordings of SEKO's
  OmniParcel code list, which the tracker shows without their codes, and the shared rules.
- OmniParcel's summary gives the service and the weight in kilograms, both kept. Its order
  references and the last-mile courier's link are not.
- SEKO's tracker also answers booking references and short partial inputs with the shipments
  that match them, so the adapter sends only whole numbers of eight to twenty letters and
  digits with a run of seven digits.

## Limitations

- OmniParcel's consignment numbers and package barcodes of the API guide's layouts are asked of
  SEKO's page, which knows only the ones SEKO moves itself.
- Neither page names a last-mile partner from the catalog or a hand-off number. OmniParcel's
  links its courier's tracking page for the same number.

## Numbers

SEKO's eCommerce parcels run through its OmniParcel platform. Its API guide and sample
tracking file give consignment numbers of three letters and seven digits, and package barcodes
that add a two-digit package counter. A Trustpilot review gives a shipping number of the same
consignment layout, which SEKO's tracker answers, and lookups archived from SEKO's tracker show
five letters and seven digits, and nine digits. Addresses archived from OmniParcel's tracker
give GX and 17 or 18 digits, which it answers. OmniParcel also carries postal S10 numbers,
which belong to the postal network that issued them.

Australia Post, Day & Ross and DSV share the consignment layout, many carriers nine digits, and
Purolator's rule claims the package barcode's, so no rule claims those, and recognition does not
ask SEKO. The five-letter layout and the GX samples are too few for a rule. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

SEKO's tracking page reads one number or several from `?trackingNumbers=` on
`sekologistics.com/en/track/`. The OmniParcel tracker on `track.omniparcel.com` opens a
number from `?id=`, from its path, or from a path that puts a numeric site prefix and a hyphen
before it.

## Testing

`npm run test:carriers:live -- carriers/seko`, with `SEKO_TRACKING_NUMBER`,
`SEKO_OMNIPARCEL_NUMBER` and optionally `SEKO_UNKNOWN_NUMBER` set outside the repository.
