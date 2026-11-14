# Xpress Logistics

Xpress Logistics parcels use enabled universal providers. There is no dedicated adapter.

Xpress Logistics, of Dudelange, is a Luxembourg courier for next-day express parcels across the
country, with drop-off depots by canton and industrial zone, storage and urgent freight. Its
tracker is a white-label page of the Conselio platform.

## Numbers

Its tracking page says a parcel number has nine digits. Many carriers use nine-digit numbers, and
no public page shows a whole one, so there is no rule.

## Why there is no adapter

A script on the tracking page checks the number's length and asks Conselio's service for the
parcel's dated statuses and its sender's name. With no public number to check its replies against,
there is no adapter.

## Leads

The page calls `GET https://xpresslogistics.conselio.com/search/{number}`, without a key or token.

## Links

Its tracker takes numbers only through its form, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
