# Amazon order

Tracks one parcel of an Amazon order through the link of the Share tracking button in the
Amazon app, on any of Amazon's retail stores. The link opens the parcel's status to anyone who
has it, so no account, session or credential is involved. It works for Amazon's own delivery,
which is otherwise only visible in the buyer's account (see [Amazon Logistics](../amazon-logistics/README.md)).

## How it works

1. `direct`: the link's `shareToken` is the tracking number, and the stored link is rebuilt
   as Amazon's own address for that token on the link's store. The adapter fetches it without
   following redirects and reads the page's `page-state` JSON: `shortStatus`, the
   `exceptionStateIdentifier` that overrides it, the progress bar's milestone and the
   promise line ("Arriving tomorrow", "Delivered 31 October").
2. `retry`: one more attempt after a network failure.
3. `recheck`: after Amazon's robot check, the same request once more 10 seconds later. The
   check answers a run of requests from one address, then lets them through again. Amazon
   answers the private browser service with HTTP 503, so no browser step follows.

## Notes

- The page must have been opened with the same token, as its sign-in link shows, or the answer
  is inconclusive.
- The page names a third-party carrier ("Delivery By COLIS PRIVE", "Enviado con Correos
  Express") but never its tracking number. The name becomes `delivery_carrier` when the
  catalog knows the words ending the heading, alone or with the store's country; Amazon's own
  delivery and a seller's name are never one. Without a number there is no hand-off.
- `catalog.tracking.linkToken` keeps the token from every universal provider: it is the key to
  the page, not a number a carrier prints. Errors carry no request address for the same reason.
- An unknown or expired token is redirected to the order history and its sign-in: the lookup
  is inconclusive (`session_rejected`), not a missing parcel. Amazon's robot check and the AWS
  WAF challenge are challenges.
- `catalog.tracking.refresh` asks a link at most every 15 minutes, and 60 minutes after a failed
  lookup, so frequent checks of a parcel out for delivery don't bring on the robot check.
- A token opens its parcel on the other European stores too, but not on amazon.com, so the
  link's store is kept.

## Limitations

- There are no scans, places or times: the result is a summary.
- The delivery estimate and delivery day stay in the status text. Amazon words them in the
  page's language, relative to the day, and without a year.
- A link stops working some weeks after delivery.
- Short links (`amzn.eu/d/…`, `a.co/d/…`) are not recognised; the full link is needed.
- No shared page from before shipping has been seen; its codes come from open-source order
  trackers.

## Testing

Set `AMAZON_ORDER_TRACKING_URL` outside the repository and run
`npm run test:carriers:live -- carriers/amazon-order/adapter.live.test.ts`.
