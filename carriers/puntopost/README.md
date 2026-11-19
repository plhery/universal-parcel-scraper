# PuntoPost

Tracks PuntoPost parcels in Mexico through the service behind PuntoPost's own tracker.

PuntoPost is the brand of PuntoPost Technologies México, S.A. de C.V. It runs a network of more
than three thousand pickup points across twelve Mexican states, centred on Mexico City. Online
shops deliver parcels to its points, and it sells shipping from one point to another. Its site is
puntopost.mx.

## Numbers

A parcel has two identifiers, both MX followed by letters and digits: PuntoPost's own code
(`MXT…` in the public sample's reply) and the shop's label (`MXL…`). The service finds a parcel
by either and is case-sensitive, so the adapter sends the number in capitals and takes MX
followed by eight to twenty-two letters and digits. Only an aggregator's example shows a whole
number, so detection has no rule and the adapter answers an explicit selection.

## Retrieval

The tracker at `www.puntopost.mx/tracking-summary/` reads the number from the address's
fragment and sends `GET back.puntopost.mx/api/web/v1/parcels/{number}`; the adapter sends the
same request. No account, key, cookie or browser is needed. Redirects are not followed, and a
request that fails to reach the service is sent once more within the budget.

The reply is the parcel's `detail`: its code and label, its status, the status history with
offsets, the origin and destination places and the movements between them. The reply must
name the number asked as its code or its label; asked by label, the code is kept as the
canonical number. An unknown number answers HTTP 404 with a `NOT_FOUND` problem for `parcel`,
which is not found; a bare 404, a refused number (400), a Cloudflare challenge or 403, rate
limits and changed replies keep their own failure kinds.

## Stages

The status codes and the Spanish wording the page shows for each come from the tracker's
script; the map is in [status.ts](status.ts). Parcels go from the shop to a depot and on to a
pickup point, where `in_destination_point` waits for collection and `delivered` is the
collection. Every `return_*` code is the way back to the sender, and the page words every
`return_fail*` code as a return to the sender, showing nothing after
`return_fail_in_origin_point`; the adapter does the same. The parcel's own status gives the
stage, as on the page's badge.

## Notes

- Each history row is one event with its status code. Where the page shows a movement instead,
  the row takes the movement's line, such as `En camino a Almacén CDMX`, and the town of the
  place it happened at: the departure for a movement under way, the arrival otherwise.
- The pickup point, with its address, is kept while the parcel is on its way to it, waits
  there or was collected there, as the page shows it; on the way back, the origin point. The
  shop's warehouse is kept as the sender.
- The points' opening hours and coordinates are left out.

## Links

`www.puntopost.mx/tracking-summary/#<number>` opens one parcel: the home page's form builds it.
The page does not read a number placed in its path.

## Testing

`npm run test:carriers:live -- carriers/puntopost` looks up the public sample and an unknown
number; `PUNTOPOST_TRACKING_NUMBER` and `PUNTOPOST_UNKNOWN_NUMBER` replace them.
