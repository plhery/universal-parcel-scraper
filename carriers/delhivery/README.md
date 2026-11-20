# Delhivery

Reads domestic parcel status and scans from the public consumer tracking feed.

## How it works

One GET with the website's Origin and Referer headers returns an identity-bound shipment.
It needs no merchant API token or account. An explicit invalid-or-old waybill response is
not-found; other empty replies remain schema failures.

Shared numeric waybill formats remain suggestions. HTTP recognition asks the same
feed and confirms Delhivery only when its identity-bound result contains shipment activity.

A thirteen- or fourteen-digit waybill is an account's series followed by a counter and a
check digit from 0 to 6, and no series starts with 0. Detection offers Delhivery only for
those, so a DPD parcel number starting with 0 or a number ending in 7, 8 or 9 is not asked
about. Delhivery does not document the check, and some series compute it differently, so
detection bounds only the last digit. DPD's fourteen digits and FAN Courier's thirteen still
fit, so recognition asks Delhivery only for a lookup in India (`servedCountriesOnly`).

## Notes

Future progress labels are excluded. Current status becomes a snapshot when no scan
reports it at the same instant; its timestamp is never assigned to an undated scan that
other scans could repeat. Anonymous tracking shows only the latest scan, undated, and the
status as a bare token ("IN_TRANSIT"). When a reply holds that one scan and nothing else, in
the status's stage and leg, the scan is the status: the snapshot takes its words and place.
Otherwise a token reads as its words, "Waiting pickup" for `WAITING_PICKUP`, which the status
map still classifies.
The parcel app's identity policy then lets the placed snapshot take over the placeless row of
its stage stored at that instant.
Freight (B2B) replies date each reached milestone instead of its scans, and a pickup
milestone can have no scans. Such a milestone becomes an event of its own. Its date has
no year: it takes the year, no more than one before the status date, in which the day
falls on the weekday shown, or else stays as written. The delivered milestone dates the
delivery, since a freight status can date a later proof-of-delivery audit, and the
delivered status then adds no snapshot of its own.
Once a shipment turns back, Delhivery relabels its "On the Way" milestone "Undelivered" at the
same date, which dates no delivery attempt: it reads as an exception. The parcel app's identity
policy lets a placeless milestone take over the placeless row at its instant, so the relabel
replaces the stored milestone instead of doubling it.
Calendar days and invalid date labels remain unresolved instead of becoming midnight scans.
The returned flow can still be in transit. Its shipment status determines current progress;
return scans retain their leg, and sender delivery does not become recipient delivery.
The parcel app's review (`statusMap`) reads the wording alone, so "Delivered" stays open there,
since the stored scan does not keep its leg.
Scan remarks, recipient information, coordinates, references and phone fields are excluded.

## Limitations

Anonymous tracking can expose only the latest undated scan; the website asks for login to
show more detail. It names no sender. Displayed delivery periods are prose, so the adapter
does not convert them into an exact delivery estimate. Freight waybills come through the
same feed. A freight LR number is another identifier, which the website first resolves to
its waybill through a separate B2B service; the adapter accepts waybills only.

## Testing

`npm run test:carriers:live -- carriers/delhivery`. Set
`DELHIVERY_TRACKING_NUMBER` to check an authorized real parcel.
