# DHL eCommerce

DHL's webshop parcel division, formerly DHL Global Mail. German DHL Paket is
[dhl](../dhl/README.md). The national parcel networks have their own carriers:
[Benelux](../dhl-ecommerce-nl/README.md), [UK](../dhl-ecommerce-uk/README.md),
[Iberia](../dhl-ecommerce-es/README.md) and [Poland](../dhl-ecommerce-pl/README.md).

## Retrieval

The `direct` step posts one anonymous lookup to `api.dhlecs.com/webtrack/v4/tracking`,
the endpoint configured by [DHL Webtrack](https://webtrack.dhlglobalmail.com/).
It covers the Americas network, including its international parcels. Recognition
uses only this HTTP lookup so ambiguous numbers can reach DHL eCommerce early.

The `browser` step retains the global tracking page's `www.dhl.com/utapi` lookup
for shipments missing from Webtrack, histories Webtrack has not published,
interactive challenges, and regional network or server failures. Webtrack misses
do not establish that DHL's global network has no shipment. Rate limits,
malformed replies, cancellation and spent budgets stop the lookup. Browser
lookups are serialized per instance.

Opt-in browser recognition goes straight to the global page after an inconclusive
HTTP check. It requires dated activity and returns the history with its confirmation.

## Parsing

Webtrack must return one identified package matching the requested number or
alias. Its `trackedValue` binds an alias to that package, as DHL's own client
does; the alias can differ from all concrete shipment identifiers. UTAPI accepts
one `ecommerce` shipment from the exact requested response URL because it can
return a different customer-confirmation identifier.

Timestamps use explicit offsets, the event's country or an identified hub.
Unresolved Webtrack clocks remain `local_time`; unresolved UTAPI clocks are
omitted. Converted instants use UTC. The coarse status does not replace a more
precise latest scan, and delivered descriptions omit signatures. Recipient
addresses and customer references are excluded.

## Limitations

US parcels handed to USPS carry a USPS number, with or without the 420 routing
prefix. Detection offers DHL eCommerce next to USPS for the `9261` and `9361`
families and Webtrack's answer attributes the parcel.

Webtrack has regional coverage. The global route needs local Chromium because
UTAPI challenges direct requests. The browser helper waits for successful API
responses, so an API error can end as a timeout. Sender names and estimates are
returned only when the chosen source publishes them.

## Testing

Run `npm run test:carriers:live -- carriers/dhl-ecommerce`. The synthetic HTTP
miss runs without credentials. Set `DHL_ECOMMERCE_TRACKING_NUMBER` outside the
repository to check an authorized Webtrack shipment.
