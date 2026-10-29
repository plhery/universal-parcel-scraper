# Correios Brazil

Tracks postal S10 references through the official anonymous single-object portal.

## How it works

Each lookup creates an isolated cookie jar, loads the portal, reads its text CAPTCHA
and submits one result request. A bundled [MIT-licensed model](model/README.md)
recognizes this portal's image locally using a CPU worker reused until idle. One fresh image
retry is allowed after unreadable text or an explicit rejected CAPTCHA. Changed
image formats and exhausted attempts report a challenge for routing fallback.

The portal now puts its query behind Cloudflare Turnstile: the page posts the number with a
form token and the Turnstile answer, and refuses the old query with HTTP 405. A browser passes
the check without interaction and gets the same JSON. Until the adapter reads it through the
browser service, a page showing Turnstile is a challenge, so lookups fall back to the providers.

## Notes

The response must echo the requested reference. Scan classification uses both the
event code and subtype; delivery-related codes also describe failures. A universal
provider's copy, which carries no Correios code, is read by the wording Correios gives
a recorded code, unless two codes word it alike with different stages. Scans keep
the provider's newest-first order, including unresolved clocks. Valid explicit
per-row IANA zones provide instants; missing, invalid or ambiguous zones retain
local clocks. Error replies without identity, including period errors, remain
inconclusive. The delivery forecast is a calendar day, kept only where the portal
shows it: for an object in transit that it does not mark as late. The service is the
product category the portal names, such as SEDEX. Addresses, recipients, proof images
and tokens are excluded.

Mail from abroad keeps the S10 number of the post that sent it, and the portal tracks it
from its arrival in Brazil, with each row's zone. It reaches Correios Brazil when a caller
names it, a provider names it (some write "Brazil Post"), or a result gives Brazil as the
destination of an S10 item. The arrival in Brazil reads as transit, and so does a posting
the sending post lists again when it dispatches the item.

## Testing

Set `CORREIOS_BR_TRACKING_NUMBER` to an authorized real reference and run
`npm run test:carriers:live -- carriers/correios-br`.
