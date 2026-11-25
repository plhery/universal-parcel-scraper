# Flip Xpress

Flip Xpress, founded in Dubai in 2019, delivers parcels and online orders across the United Arab
Emirates and ships abroad, with pickup, warehousing and drop-off for online sellers. Its site is
flipxp.com.

## Retrieval

The tracking page asks `GET portal.flipxp.com/apis/manifest_status_multiple?awb_number=<number>`, an
open JSON lookup without a session, key or CAPTCHA. The adapter asks it for one waybill and keeps the
entry whose `awb_number` is the number asked. An unknown waybill gets an empty list with HTTP 200, the
only answer read as not found; refusals, block pages, redirects and changed replies keep their own kinds.

Statuses come oldest first, each with a code, the wording the page shows (`status_real_name`) and a UTC
instant; the adapter lists them newest first and stages them by code. The status's other wording, which
adds the driver's code and the name of whoever took the parcel, the addresses and the contents are
never read.

## Numbers

Waybills are fifteen digits, or a booking reference: `TL`, the year and month, a hyphen and a serial.
The tracker finds a booking reference only with its hyphen, which normalization drops, so the adapter
asks for both forms in one lookup, joined by a comma as the tracking page joins several numbers, and
keeps the entry whose letters and digits are the number's. It accepts letters, digits and hyphens only.
No public page states the layouts, so there is no detection rule, and preflight never asks Flip Xpress.

## Links

The tracking page keeps the number out of its address, so there are no tracking links.

## Testing

```sh
npm run test:carriers:live -- carriers/flipxpress
```

`FLIPXPRESS_TRACKING_NUMBER` and `FLIPXPRESS_UNKNOWN_NUMBER` replace the public sample and the invented
number.
