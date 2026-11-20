# Correios Brazil

Tracks postal S10 references through the official anonymous single-object portal.

## How it works

Each lookup creates an isolated cookie jar, loads the portal, reads its text CAPTCHA
and submits one result request. A bundled [MIT-licensed model](model/README.md)
recognizes this portal's image locally using a CPU worker reused until idle. One fresh image
retry is allowed after unreadable text or an explicit rejected CAPTCHA. Changed
image formats and exhausted attempts report a challenge for routing fallback.

The portal now puts its query behind Cloudflare Turnstile: the page posts the number with a
form token and the Turnstile answer, refuses the old query with HTTP 405 and a refused token
with HTTP 403. The direct step stops at a page showing Turnstile, and the `trawl` step asks the
browser service. It opens the portal's share link, `index.php?objetos=`, which fills in the
number, waits for Turnstile's token, interacting with its checkbox when shown, and searches.
The service keeps only the reply whose request carried the whole number, the same
JSON the direct query read. After a page showing Turnstile, lookups go straight to the
`trawl` step for a few hours, then the direct step looks again; an unreadable or rejected text
CAPTCHA starts no such rest. Without a browser service, Turnstile is a challenge and lookups
fall back to the providers. The portal answers a burst of lookups from one address with HTTP
429, a rate limit rather than a missing parcel, and does so more often the denser an address
asks: a few in a hundred reads at seven or fewer in ten minutes, one in five at ten or more. So
one browser service sends Correios at most seven reads in any ten minutes, shared by every
tracker in the process; a read past that waits for its turn when the lookup has the time, and
otherwise fails as our own pacing (`rate_limited`, `self_paced`) with the wait. A host that
keeps adapters' holds (`keepAdapterHolds`) keeps the window, and the direct step's rest, across
restarts. Fixed `correios.verification` diagnostics
record token receipt, submission, response counts, HTTP statuses, widget clicks and when the
page loaded, the token arrived and the reply came, without the number, token or response body. A response diagnostic is not a claim that its history parsed.

## Notes

The response must echo the requested reference. Scan classification uses both the
event code and subtype; delivery-related codes also describe failures. A universal
provider's copy, which carries no Correios code, is read by the wording Correios gives
a recorded code, unless two codes word it alike with different stages. A wording Correios
documents without a code, such as its import guide's payment notice, stages a scan whose code is
not recorded and a copy alike; a recorded code still decides. Scans keep
the provider's newest-first order, including unresolved clocks. Valid explicit
per-row IANA zones provide instants; missing, invalid or ambiguous zones retain
local clocks. The single-object query treats an explicit object-not-found reply as absence when it is
bound to the requested object. Other portal errors, including period errors, stay
inconclusive and carry the portal’s message in lookup diagnostics. The delivery forecast is a calendar day, kept only where the portal
shows it: for an object in transit that it does not mark as late. The service is the
product category the portal names, such as SEDEX. A unit's place is its town and state
followed by `BR`, since a state code alone reads as a country (PR as Puerto Rico, ES as
Spain). A receipt worded to end with its unit, "Objeto recebido em", reads "Objeto recebido"
when the reply gives the unit no address. Addresses, recipients, proof images and tokens are excluded.

Mail from abroad keeps the S10 number of the post that sent it. The portal lists that post's
posting, office of exchange and dispatch (a transfer without a Brazilian unit, before the
item's first scan in Brazil), then the item from its arrival in Brazil, with each row's
zone. Customs' review of the declaration names a Brazilian unit and can come before the
item arrives, so it does not count as the first scan in Brazil. The sending post's rows carry its wall clock but Brasília's zone, as China Post's own
scans of the same items show, so they are read on the clock of the country the number ends
with, its main clock where it keeps several (basis `carrier`): a wall clock left alone would
be dated on Brasília's zone after the parser. It reaches Correios Brazil
when a caller names it, a provider names it (some write "Brazil Post"), or a result gives
Brazil as the destination of an S10 item. The arrival in Brazil reads as transit, and so
does a posting the sending post lists again when it dispatches the item. An import Correios
numbers itself (`NN…BR`) lists the declaration sent to customs first and its posting when the
shipper hands the item to the airline abroad: a posting listed after the item has moved on
reads as transit too.

## Testing

Set `CORREIOS_BR_TRACKING_NUMBER` to an authorized real reference and `FLARESOLVERR_URL` to a
browser service built from [trawl](../../trawl/README.md), then run
`npm run test:carriers:live -- carriers/correios-br`.
