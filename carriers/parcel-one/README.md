# PARCEL.ONE

PARCEL.ONE GmbH is a German cross-border shipper for online shops. It collects parcels at its
own hub in Pohlheim and hands them to carriers in about fifty countries. Its tracker follows a
parcel from the sender to the hand-over, then relays the delivery carrier's scans.

## Numbers

Its own tracking ids are thirteen digits in its API documentation, a shape many carriers share,
so no rule names PARCEL.ONE. The tracker also finds a parcel by the delivery carrier's number.
The adapter takes 6 to 40 letters and digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `GET https://parcel.one/wp-json/parcelone/v1/track?trackno={number}&zip=&lang=en`,
   the request the tracking page's script makes. It needs no session, token or cookie.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of it.

The page asks for the number and, optionally, the recipient's postcode. The adapter leaves the
postcode empty, as the page sends it without one: an empty or a wrong postcode gets the same
reply, without the recipient's name and address, which the page shows beside the right one. The
adapter never reads them, nor the postcode the reply repeats.

The reply repeats the number asked, and the adapter keeps it only for that number. A found parcel
has the progress code of the page's five steps, a partner block with the delivery carrier's
number and a link to its tracker, and the scans newest first, each with a wall clock to the
minute, an English wording and a place: a country code and town for PARCEL.ONE's own steps, the
delivery carrier's office code for its scans. The adapter asks in English, the tracker's other
language being German. A scan's link to the delivery carrier's tracker becomes its text.

A number the tracker holds nothing for gets `found: false` with "No data could be found for the
entered Tracking Number and Receiver ZIP Code!", read as not found. Another message, or a
reply for another number, leaves the answer open. A refusal or a browser check is a challenge,
a 503 maintenance, a redirect or a missing route a transport failure, and a page in place of
the JSON a changed reply.

There is no recognition: no detection rule offers PARCEL.ONE for a number, so preflight never
asks it.

## Hand-over

The partner block names the delivery carrier when its tracking link, else the link around its
logo, is one catalog carrier's and the number fits that carrier's rules or is the one the link
opens. Its number becomes the delivery number either way, unless it is the number asked. In the
sample, Liechtenstein Post's eighteen digits link to Swiss Post's tracker, which follows them.

## Status

Scans carry wording only, staged by the map and else by the shared wording rules. The label
PARCEL.ONE creates for the delivery carrier at the hub, after the parcel arrived there, is in
transit. The newest staged scan sets the parcel's stage. The progress code stands in when no
scan has a stage, and alone for a parcel without scans, but only for the four steps the page's
script names.

## Clocks

The reply names no zone, so each scan keeps its wall clock in `local_time`. PARCEL.ONE's own
steps are in Germany; the delivery carrier's scans keep the clock PARCEL.ONE relays them on,
which it does not name. Node lookups date them on a zone deduced from the scan's place, else
from the scans around it or the catalog's Berlin clock.

## Limitations

- No delivery estimate, destination country, instants or proof of delivery.
- The map holds the wordings seen with the sample. Other delivery carriers' relayed scans keep
  their wording, staged by the shared rules where they can be.
- A delivery carrier whose link names no single catalog carrier is not named.

## Links

The tracking page's `?trackno=` opens one number.

## Testing

```sh
npm run test:carriers:live -- carriers/parcel-one
```

It reads the public sample from `numbers.json`; `PARCEL_ONE_TRACKING_NUMBER` and
`PARCEL_ONE_UNKNOWN_NUMBER` set outside the repository replace the sample and the synthetic
unknown number.
