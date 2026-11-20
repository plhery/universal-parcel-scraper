# GLS Hungary

GLS Hungary is the GLS group's network in Hungary. It tracks its national parcel numbers, 10
digits or 11 written with a leading zero, and GLS's international parcels that pass through
Hungary, through the group's tracking service under Hungary's own path.

## How it works

1. `direct`: the anonymous `rstt029` overview at
   `https://gls-group.eu/app/service/open/rest/HU/en/rstt029`, the request GLS Hungary's
   tracking page makes. A request that fails to reach GLS, or hangs, is sent once more within
   the lookup budget.

- GLS Hungary's national numbers exist only under the Hungarian path: the group path that
  [gls-de](../gls-de/README.md) and [gls-ch](../gls-ch/README.md) ask answers them with `E000`.
  That is why Hungary has an adapter of its own while Austria's numbers go through gls-de.
- The reply must hold exactly one row whose `tuNo` is the whole requested number. Its progress
  bar is read by gls-ch's parser, so the status codes and their stages are the group's.
- The overview has no scans: GLS shows them only with the delivery postcode. The answer is the
  status, marked `summary_only`, which a fuller history from an enabled universal provider
  replaces. The status leaves out the page's pointer to the scans it lists below it. A status code the parser does not know is indeterminate, not a missing parcel.
- Only GLS's own `E000` and `E206` on an HTTP 404 are not found. Any other 404, and a 200 with no
  row, leave the answer open.
- Links to `gls-group.com/HU/` or `gls-group.eu/HU/` name this carrier, whatever the number,
  since that page tracks the same parcels as the adapter.

## Limitations

- No scans, location, pickup point or delivery estimate: the detail request needs the
  recipient's postcode, which this carrier does not ask for.
- No detection rule: GLS Hungary's 10- and 11-digit numbers overlap other carriers' numeric
  formats, so it is reached by link, name or the carrier picker.

## Testing

`npm run test:carriers:live -- carriers/gls-hu`
