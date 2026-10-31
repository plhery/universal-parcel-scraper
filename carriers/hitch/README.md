# Hitch

Hitch parcels use enabled universal providers. There is no dedicated adapter.

Hitch, formerly Zip PH, is the brand of Z International Parcel Services, a Philippine business-to-business
courier delivering for online shops and other businesses across Luzon, the Visayas and Mindanao, with
warehousing and fulfilment. Its site is hitch.com.ph; zip-ph.com now only points there.

## Numbers

Its tracking numbers are `ZIP` and twelve letters and digits, which `hitch-1` suggests at low confidence: every
example is an archived lookup on Zip PH's tracker, and none is known from after the rename. Its tracker also
finds a booking by its reference number, `B` and seven digits, a shape other carriers' rules share, so no rule
takes it.

## Why there is no adapter

Its tracker is an open HTML page without a session or CAPTCHA: `GET hitch.com.ph/tracking?no={number}`, with
the tracking or the reference number. It answers one of the archived examples with its scans, on local clocks
without an offset, and an unknown number with HTTP 200 and "Oooops! we couldn't find any bookings/results
matching", so an adapter has to read the text. No adapter has been written for it yet.

## Links

The tracking page opens numbers from its `no` parameter. Links to zip-ph.com, its former site, now reach only
a notice pointing to hitch.com.ph, so no rule reads them.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
