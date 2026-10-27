# SEUR

Tracks single-piece shipments through SEUR's public simplified lookup, by SEUR's
numbers, by a sender's twenty-two-digit reference or by twelve digits a provider
names SEUR for. Other references and multi-piece shipments use universal providers.

## How it works

One JSON request uses the same simplified lookup as the consumer portal's
tracking links. It needs neither an anonymous session nor recipient details.
The returned search identifier must exactly match and have nonempty history.

## Notes

Current status follows the first native scan other than a delay notice. A
delay notice (LI300, LI582, LI557) is no movement: the row keeps the stage of the
scan before it. Only observed code, group and wording combinations are mapped,
so planned delivery or unfamiliar codes do not inherit an older terminal state.
A code seen without its group takes the group of a code with the same wording. SEUR marks its scan clocks as UTC, but they
are Spanish wall clocks: DPD gives the same scans the same digits with Madrid's
offset. A scan names no place, and the lookup names no destination, while SEUR
also scans in the Canary Islands, an hour behind Madrid. No scan's zone is
known, so clocks remain local time; only a numeric offset makes an instant.
Unreadable clocks remain provider text. A delivery instant needs the current
delivered scan's own offset.

Scan comments, names, contact details, QR codes, delivery PINs and driver
coordinates are excluded. Shipment weight uses the portal's kilogram label.

The lookup also finds a shipment by its sender's reference and names the
reference as the identifier searched. Some senders print a twenty-two-digit
reference as the tracking number: a date, read as year, day and month, then
fourteen digits. `seur-4` suggests SEUR for that layout and recognition asks
SEUR. APC Overnight's rule takes the same length with the month before the day,
so both are suggested when the day is twelve or less.

A seven-digit number is the short expedition number inside SEUR's twenty-one-digit
shipment key. SEUR reuses it: about a third of random seven-digit numbers find a recent
shipment. Tracking accepts it, but recognition only asks SEUR for its fourteen, twenty-one
and twenty-two-digit numbers, so a seven-digit hit never files someone else's number under
SEUR.

Universal providers name SEUR for some twelve-digit numbers, which its lookup also finds.
Tracking accepts them so the lookup can confirm the provider's naming. Twelve digits fit many
carriers' rules, so no rule suggests SEUR for them and recognition never asks it.

A pickup request's reference is `REC` and twelve digits, the `collectionRef` of SEUR's
business API, which tracks it only for the account that booked the pickup. It names a pickup,
not a parcel, and the public lookup answers the published ones as unknown numbers, so no rule
claims it and tracking refuses it.

The no-history error also covers recent or out-of-range identifiers and remains
inconclusive, with the reason `portal_not_found` so a consumer can tell it from
an outage. Empty replies, redirects and generic HTTP errors are inconclusive
without a reason. The firewall's script page is a challenge, never a missing
parcel.

Links to seur.com's home page, its `miseur/mis-envios` pages, in Spanish or
English, and its `livetracking` page name SEUR; its other pages name none.

## Testing

Set `SEUR_TRACKING_NUMBER` to an authorized reference and optionally
`SEUR_UNKNOWN_NUMBER` to a valid-looking unresolved identifier, then run
`npm run test:carriers:live -- carriers/seur`.
