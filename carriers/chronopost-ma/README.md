# Chronopost Maroc

Tracks Chronopost Maroc parcels and the EMS items from abroad it delivers in Morocco.

Chronopost Maroc, Chronopost International Maroc, is the express parcel company of Poste Maroc and
Geopost in Morocco. It is separate from [Chronopost](../chronopost/README.md) in France.

## How it works

`direct` posts the number to the lookup the tracking page's script makes,
`/umbraco/Surface/TrackingSurface/GetTrackingEvents` on chronopost.ma, as
`{"SendingNumber": <number>, "Mode": 2}`: no session, token or browser. The page loads Google's
reCAPTCHA script, but the lookup sends no token. `Mode` 2 is the page's own choice, its web
service; `Mode` 1, its database, answers every number with an empty history.

The reply lists the events newest first, each with a wording, a place and sometimes a reason,
which is added to the wording. The events must name the whole requested number, as the parcel's
number or its associated one. The page calls the newest the last event.

An event's clock is a wall clock without a zone: the reply writes it as a UTC instant and repeats
the time of day apart, and the page shows it as written. The adapter keeps it in `local_time`
and rejects a reply whose two copies disagree.

The origin, destination, piece count and associated number are left out.

## Numbers

The tracker takes a parcel, collection or missed-delivery notice number. It matches numbers in
capitals only, so the adapter sends them that way, without spaces. Its parcels include EMS items
from other posts, which keep their senders' numbers, so there is no rule: Chronopost Maroc is
asked when it is selected.

## Limitations

A number the tracking service does not know gets the site's HTTP 500 error page, relaying the
service's 404; that is not found. Any other failure it relays is inconclusive.

## Links

`chronopost.ma/suivez-votre-envoi?SendingNumber=<number>` looks one number up, and the library reads
the number from that address.

## Testing

`npm run test:carriers:live -- carriers/chronopost-ma`
