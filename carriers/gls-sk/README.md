# GLS Slovakia

GLS Slovakia is the GLS group's network in Slovakia. It tracks its national parcel numbers,
10 digits or 11 written with a leading zero, and GLS's international parcels that pass through
Slovakia, through the group's tracking service under Slovakia's own path.

## How it works

1. `direct`: the anonymous `rstt029` overview at
   `https://gls-group.eu/app/service/open/rest/SK/en/rstt029`, the request GLS Slovakia's
   tracking page makes. A request that fails to reach GLS, or hangs, is sent once more within
   the lookup budget.

- GLS Slovakia's national numbers exist only under its own path: the group path that
  [gls-de](../gls-de/README.md) asks answers them with `E000` or `E206`. The lookup is
  [gls-hu](../gls-hu/README.md)'s, set to this country, and reads the reply the same way: one
  row whose `tuNo` is the whole requested number, its progress bar read by gls-ch's parser, the
  status marked `summary_only`, and only GLS's own `E000` and `E206` on an HTTP 404 not found.
- Links to `gls-group.com/SK/` or `gls-group.eu/SK/` name this carrier, whatever the number,
  since that page tracks the same parcels as the adapter.

## Detection

No rule offers GLS Slovakia: its numbers are bare runs of digits that other carriers print too.
A parcel is reached by link, name or the carrier picker.

## Limitations

- No scans, location, pickup point or delivery estimate: the detail request needs the
  recipient's postcode, which this carrier does not ask for.
- A 12-digit number, the 11 digits with GLS's check digit, is not taken: the overview answers
  it with the 11-digit parcel, which the lookup cannot bind to the number asked.

## Testing

`npm run test:carriers:live -- carriers/gls-sk`
