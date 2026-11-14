# Bypost

Bypost parcels use enabled universal providers. There is no dedicated adapter.

Bypost, Bypost AS of Skien, is a Norwegian postal and courier company in southern Norway with its
own vehicles and terminals. It carries letters and mass mailings, business parcels up to 35 kg,
courier deliveries and library transport.

## Numbers

Its tracking page takes a tracking or parcel number of 6 to 40 letters and digits. Its example has
17 digits starting 70, the shape of Bring's consignment numbers, and no public page shows a real
number, so there is no rule.

## Why there is no adapter

The tracking page reads the number from its address and asks Bypost's JSON service for the
shipment's status timeline. With no public number to check its replies against, there is no
adapter. The proof of delivery, a signature or photos, is behind the recipient's phone number.

## Leads

The page calls `GET https://bypost.no/api/track?number={number}`, and adds the recipient's phone
number as `recipient_phone` to show the proof of delivery.

## Links

`https://bypost.no/spor/{trackingNumber}/` opens the tracking page on the number. A pasted
bypost.no `/spor/` link with a number names Bypost.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
