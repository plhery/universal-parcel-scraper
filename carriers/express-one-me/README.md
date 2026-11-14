# Express One Montenegro

Express One Montenegro parcels use enabled universal providers. There is no dedicated adapter.

Express One Montenegro d.o.o., of Podgorica, is a Montenegrin courier that delivers parcels to
homes and businesses across Montenegro, with regional and international transport. AntSoft
built its site and tracker, on its own host, as it built those of
[City Express](../city-express-rs/README.md) in Serbia. Its tracker is not the one
[Express One](../express-one/README.md) uses in Hungary or the one of
[Express One Bulgaria](../express-one-bg/README.md), so the three are kept apart.

## Numbers

Its tracking page asks for a shipment centre, 499 001 or 499 005, and a shipment or parcel number
in digits, or for a sender's reference with the sender's partner number. No public page shows a
whole number, so there is no rule.

## Why there is no adapter

The page loads each answer as an htmx fragment,
`GET /htmx-fragment/shipment-trace-by-number-result` with the centre and the number, sent with
the page's session and CSRF token, the request City Express's adapter makes on its own site. With
no public number to check its replies against, there is no adapter.

## Links

Its tracker takes numbers only through the page's form, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
