# Shree Nandan Courier

Shree Nandan Courier is a domestic courier network in India. Select it explicitly: its shipment
numbers have eleven or thirteen digits, and digit runs of these lengths are printed by many other
carriers, so no rule claims them.

## Retrieval

The carrier's Connecting Nandan platform shows a shipment at `connectingnandan.com/web-tracking/{number}`.
That page posts `{"con_no", "purpose", "is_external_tracking": 1}` as plain JSON to
`api.connectingnandan.com/v1/utilities/tracking/web-view/{number}` three times: `purpose` 1 returns
the travel rows, 2 the booking and 3 the delivery records. The adapter makes the same three
requests at once with the page's `api-key`, `app-id` and `platform` headers, which are the same
for every visitor. Each reply names the number it answers, and the booking names it again; an
answer for another number fails the lookup.

The tracker on the carrier's website calls the same API through another route. It encrypts each
key and value of the body, and opens its results at an address holding an encrypted value instead
of the number. The adapter uses the platform's route, which needs neither.

## Choices

The clocks are Indian wall clocks without an offset, so scans keep them as local times. A delivery
record has only a delivery date, which stays a date and comes after the scans of its day. The
booking date becomes a "Booked" scan at the booking office. The text of a travel row is shown in
parts; the adapter joins them and leaves out the office's phone number.

The website shows the booking's status as the shipment's. The adapter takes it as the current
stage when it names a delivery, since scans can still be written at a hub after a delivery
record. Otherwise the newest scan sets the stage.

## Limitations

The tracker shows a shipment for 180 days. For an older one the API answers HTTP 423 with a
notice naming the booking branch to contact, which the adapter reads as expired history. An
unknown number gets three empty parts, which the website shows as "No Record Found"; the adapter
reads that as not found. Proof-of-delivery images, office phone numbers and addresses are left
out.

## Links

Lookups archived from the older tracker carry the number as `cn` on `TrackingInfo.aspx`, and the
Connecting Nandan platform shows it in `/web-tracking/` addresses; the number is read from both.

## Testing

```sh
SHREE_NANDAN_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/shree-nandan
```

`SHREE_NANDAN_UNKNOWN_NUMBER` adds a check of the not-found answer for a number the carrier does not hold.
