# Garudavega

Garudavega parcels use enabled universal providers. There is no dedicated adapter.

Garudavega is an international courier in Hyderabad, India. It sends parcels and documents from
India to families abroad, in the United States, the United Kingdom, the United Arab Emirates,
Australia, Canada and other countries, from branches across India. Its site is garudavega.com.

## Numbers

The only public example is eleven digits, from an aggregator. Eleven-digit runs are other
carriers' numbers too, so there is no rule.

## Why there is no adapter

Its tracking page renders the result on the server at `/track/<number>`. No JSON API is behind
it.

## Links

`www.garudavega.com/track/<number>` opens one shipment: the tracking form builds it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
