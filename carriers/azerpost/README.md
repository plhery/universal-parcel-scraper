# Azerpost

Azerpost parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Azerpost prints UPU S10 numbers ending in `AZ`; its tracking page gives a `CP` parcel as its
example, and archived lookups on its former tracker show items starting `SS`, `BB`, `RR`, `CP`
and other prefixes. Generic postal detection handles S10 numbers, so Azerpost has no rule of
its own.

## Links

The tracking page reads the number from its `package_id` parameter in Azerbaijani, English and
Russian, and the home page's search form builds that address. The former tracker opened one
parcel at `/az/tracking/{number}` or `/en/tracking/{number}`; those addresses now return an
error.

## Why there is no adapter

The tracking page's script asks reCAPTCHA v3 for a token, takes a CSRF token from `/api/get-csrf`,
and posts the number with both to `/api/get-package/{language}`, which answers the item's events
as JSON. It gave the same "Tracking number not found" reply without a token, with a made-up one
and with a browser's real one for every public number tried, the page's own example included. No
current public Azerpost number is known to show what a found item needs.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
