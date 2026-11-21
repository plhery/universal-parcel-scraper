# Fixtures

`delivered.html` and `in-transit.html` follow the page SEKO's server renders for
`/en/track/?trackingNumbers={number}`: the shipment's summary, its step rail, then its
milestones oldest first, with the newest record first within a minute. `delivered.html` repeats
a status change in another case, lists a delivery's proof-of-delivery records after it and
carries a signer, references and postcodes. `in-transit.html` gives a delivery window. An
unfinished shipment's step rail follows the delivered one's markup; the parser does not read it.
Their numbers, names, references, places, postcodes and clocks are invented. An unknown number's
page is built inline in the tests.

`public-delivered.html` is the tracking section of the page SEKO serves for the shipping number
a [Trustpilot review](https://www.trustpilot.com/reviews/6aa065e723f57535b0e1f741) gives, as
served, without the sidebar's icons.
