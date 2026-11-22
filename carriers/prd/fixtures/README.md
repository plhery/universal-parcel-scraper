# Fixtures

The replies are `Service.ashx`'s JSONP for one number, as the adapter asks it.

- `in-transit.txt` is synthetic, in the layout of a live reply: the made-up number from
  [numbers.json](../numbers.json), made-up references, dates and warehouse, and the tracker's
  own wordings. The parcel has flown to Amsterdam, cleared customs and waits for J&T Express
  Germany, whose number `channel_hawbcode` holds.
- `not-found.txt` is the live answer for a number the tracker does not know.
