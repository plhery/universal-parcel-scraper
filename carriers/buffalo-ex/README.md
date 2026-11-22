# BUFFALO

BUFFALO parcels use enabled universal providers. There is no dedicated adapter.

BUFFALO International Logistics ships parcels from China to South Africa, clears them through
South African customs and delivers them from its own depots or hands them to a local courier.

## Numbers

BUFFALO's tracker calls its number the order number. Archived lookups on its tracker show
BUFZA, ten digits and YQ; ParcelsApp names BUFFALO for BUFZA, a digit, SK, five digits and BUYQ.
The high-confidence rule claims both layouts: the BUFZA prefix and YQ suffix are BUFFALO's own. The former tracker used fifteen-digit order numbers; no rule claims
them, since many carriers print bare digit runs of that length. The customs reference the
tracker shows next to the number is not a tracking number.

## Statuses

ParcelsApp relays the local courier's round as "SCAN VEHICLE DEPARTURE" early in the morning,
and the parcel back at the depot undelivered that evening as a bare "RETURNS"; it leaves again on
the next round, and after rounds like these goes back to the sender. The courier collecting the
parcel from BUFFALO's depot, after the customs release and the hubs, is "COLLECTED". Rules scoped
to BUFFALO and ParcelsApp read the departure as out for delivery, the return as a failed attempt
and the collection as in transit; elsewhere a vehicle can leave for another depot, the word can
name a return to the sender, and a collection is the acceptance.

A depot taking the parcel back from the courier, "Returned to BUFFALO warehouse[…]" with the depot's code, is
an exception: no round goes on.

## Links

`buffaloex.com/tracks.html?order={number}` is the address the site's home page form submits to;
the tracker opens with an empty form. Archived lookups used the former `track.html` page and the
`express/record` page with the same `order` parameter.

## Limitations

BUFFALO's tracker asks for the last four digits of the parcel's phone number, an image code and a
Cloudflare Turnstile check before it shows a history, and its app tracks only a signed-in
customer's orders, so BUFFALO stays on universal providers. Domestic South African orders start
`BUFEX-` and belong to BUFFALO's South African site. Its
[tracker](https://www.buffaloex.co.za/track.html) can return HTTP 418 with an
access-block page and the cookie names `HWWAFSESID` and `HWWAFSESTIME`. The
block page contains no tracking form or interactive verification control. An
ordinary tracker session and a fresh private homepage session both remained
blocked; a country-wide restriction has not been established.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
