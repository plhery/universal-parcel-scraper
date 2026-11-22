# X Express Serbia

X Express Serbia, X Express DOO of Belgrade, is a Serbian courier with regional centres and
parcel lockers across Serbia. Its site follows that of [X Express](../x-express-ba/README.md) in
Bosnia and Herzegovina, but its tracker runs on its own host and takes another number layout, so
the two are kept apart.

## How it works

`direct` opens `https://www.x-express.rs/korisnicki-panel/pracenje-posiljke/<number>`, the share
link the tracker's result page publishes beside the number. It needs no session, token or account,
unlike the search form, which posts the number with a reCAPTCHA v3 token and a small sum. The page
echoes the number it found, which must be the whole number asked, then the current status and the
scans, newest first, each with its wording and a time to the minute. A message that the number
asked was not found ("Pošiljka sa kodom … nije pronađena") is a shipment X Express does not know.
The host's "One moment, please..." check is a challenge, and a page with neither a result nor
that message an error. A request that fails to reach the server gets one `retry` in the rest of
the budget.

The scans keep their wall clock, which is Belgrade's, as the page gives no offset, and name no
place. The page also shows the recipient's masked name and town and the sender's name, which the
adapter leaves out.

## Numbers

A shipment number is two digits, a hyphen and ten digits, as the tracking page's example prints
it. The tracker does not find the twelve digits without their hyphen, so the adapter and the links
restore it. Digits alone match many other carriers' numbers, so there is no rule and the carrier
needs explicit selection. The page also takes a shipment's GUID, which the adapter does not accept:
no public sample shows one, and its reply could not be bound to the GUID asked. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The share link opens one shipment by its number.

## Limitations

No place, estimate, weight or proof of delivery. Only the wordings seen on the example are mapped;
a service request, "Usluga - …", moves nothing and keeps the stage of the scan before it.

## Testing

`npm run test:carriers:live -- carriers/x-express-rs`

The live test tracks the public sample in `numbers.json`; `X_EXPRESS_RS_TRACKING_NUMBER` tracks
another shipment, and `X_EXPRESS_RS_UNKNOWN_NUMBER` checks the not-found answer.
