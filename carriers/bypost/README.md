# Bypost

Tracks shipments of Bypost, Bypost AS of Skien: a Norwegian postal and courier company in
southern Norway with its own vehicles and terminals, carrying letters, business parcels up to
35 kg, courier deliveries and library transport.

## How it works

`direct` asks the service behind the tracking page, `GET https://bypost.no/api/track?number={number}`:
no session, token or browser.

The reply's fields and codes are taken from the tracking page's script, which holds the
wording of each shipment status and event code. A shipment lists its packages, each with its
own number and events. The shipment's number reads every package; a package's own number
reads that package. A shipment of several packages counts as delivered once each package is.
A cancelled shipment is stopped whatever its events say. No event code states an exception
("Avvik"), so a shipment's exception stands over its events unless they end in a delivery or a
return. A package on its way back to its sender is an exception until it is returned.

An event keeps its code as `provider_code` and the label the service gives it, else the page's
wording for the code. A code the page does not list is kept without a stage, as are the four
notices about a delivery date or a home delivery order.

Event clocks are read only with the offset the service states. The town of a scan, the
destination country, the weight and a single package's pickup point are read. The destination's
postcode and town are read as the recipient's address, and a delivery's signature as who signed.
Scan postcodes, dimensions and the proof of delivery are left out, and the recipient's phone
number, which opens the proof of delivery, is never sent.

## Numbers

The tracking page takes a tracking or package number of 6 to 40 letters and digits. Its
example has 17 digits starting 70, the shape of Bring's consignment numbers, and no public
page shows a real number, so there is no rule. Bypost is asked when it is selected or when a
tracking link names it.

## Limitations

The service answers an unknown number and a shipment not collected yet the same way, with an
empty shipment; both read as not found. A 404 is a moved service, not a missing parcel.

A registered shipment without events is a summary: its status and the page's sentence for it.

## Links

`https://bypost.no/spor/{trackingNumber}/` opens the tracking page on the number. A pasted
bypost.no `/spor/` link with a number names Bypost.

## Testing

`npm run test:carriers:live -- carriers/bypost`
