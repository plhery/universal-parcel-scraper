# QT Express

Tracks QT Express parcels by tracking number.

QT Logistics Group Kft. in Vecsés clears e-commerce parcels from China into Europe and delivers
them in Europe and the Balkans under its QT Express brand and its own numbers. Part of its last
mile can go to partner couriers. Its site is qtlogistics.eu.

## How it works

`direct` reads the parcel from the service behind the tracking site,
`tracking.qtlogistics.eu/api/v1/trackings/<number>`: no session, token or browser.

The reply's fields, statuses and failure reasons are taken from the tracking site's own script
and its Hungarian translations. A parcel is a list of events, each with a status, a date and,
for a failed delivery, a reason. The status is the `provider_code`; the description is the
page's wording for it, in Hungarian for a Hungarian reader and in English for everyone else.
A status the script does not list is kept without a stage, and the stage is the newest listed
one, as the page keeps to the steps it knows; a delivery under a newer unlisted status may have
been undone, so it no longer sets the stage.

A failed delivery is worded with its reason as the page words it: by the event's reason code,
else by the service's English text for one, else the text as written. A reason the courier
typed is left out, as the Hungarian page leaves it out.

A parcel sent back to the depot is not delivered again and waits there for its return. The
return has not started, so it is an exception; "Returned to sender" is the return.

Event clocks are read only with the offset the service states; a clock without one is rejected
instead of being given a zone.

The reply must name the requested number.

## Numbers

No public page shows a QT Express number or its layout, so there is no rule: QT Express is
asked when it is selected or when a tracking link names it.

## Limitations

The page shows each event's day only, so the script does not say how the service writes a
clock. A reply whose clocks carry no offset fails as a changed service and the lookup goes on
to the enabled universal providers.

The service's own description of a step is not read: it is written for the carrier's staff.

A missing parcel is the service's HTTP 404 with `not found`, or a parcel without an event,
which the page shows the same way. Any other 404 is read as a moved service, never as a missing
parcel.

## Links

The tracking site opens a number from its path, after `/hu/` or `/en/`.

## Testing

`npm run test:carriers:live -- carriers/qt-express`
