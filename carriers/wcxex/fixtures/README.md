# Fixtures

- `delivered-usps.txt`: the lookup's reply for the public sample from an archived capture of
  ParcelPanel's page for the line: a parcel flown to Los Angeles that USPS delivered to a mailbox.
- `delivered-speedx.txt`: the reply for the sample beside the tracking box of the carrier's own
  site: a parcel flown to New York that SpeedX delivered, with SpeedX's number.
- `not-found.txt`: the reply for `ZZ0000000000ZZ`, a string outside WCXEX's layout.

The merchant's reference reads as zeros; the rest is as received, under the adapter's callback name.
