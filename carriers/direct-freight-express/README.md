# Direct Freight Express

The dedicated adapter reads the public consignment status page. Its thirteen-digit format is
shared with other carriers, so there is no offline detection rule. Choose the carrier explicitly
or open its whole-number tracking link.

HTTP is tried first. A network failure gets one retry; an identified browser challenge can use
the configured TRAWL service. Both paths parse the same shipment identity and history. Rate
limits, malformed pages and definite replies do not launch a browser. The ordinary TRAWL image
is sufficient; no carrier-specific service module is needed.

The page renders desktop and mobile copies of each scan. The parser checks that they agree,
then keeps one complete timeline, depot locations and the stated delivery-estimate day. Scan
clocks stay local because the page gives no offset. Capped histories stay incomplete. Pickup and
delivery addresses, item counts and proof-of-delivery controls are omitted.

The dispatch API requires an account's key and account number. The adapter uses the public
tracking page, without account access.

Run the opt-in live test with `DIRECT_FREIGHT_TRACKING_NUMBER` and `FLARESOLVERR_URL`:

```sh
npm run test:carriers:live -- carriers/direct-freight-express
```
