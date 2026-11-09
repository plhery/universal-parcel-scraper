# DHL eCommerce Poland

DHL's domestic parcel network in Poland, formerly DHL Parcel Polska. German
DHL Paket is [dhl](../dhl/README.md); the Benelux network is
[dhl-ecommerce-nl](../dhl-ecommerce-nl/README.md).

## Retrieval

The guest API at `mojdhl.pl/api/dhl/public` issues a request challenge, then
accepts the number and its proof at `shipment/status`. The response must name
the whole requested number and contain one shipment. An empty shipment list
without a number type confirms absence; several shipments are ambiguous.

With the optional TRAWL service, the adapter uses that shipment's confirmed
waybill to request scan history from `sprawdz.dhl.com.pl`. A fresh context
rejects optional cookies, completes the page's reCAPTCHA flow, and submits
its form. The captured POST and the returned history must both name the
waybill. Recipient acknowledgements, form tokens and self-service links are
excluded before the browser response leaves the service.

The API and the history page answer in English or Polish. The API is asked in
Polish (`Accept-Language: pl`) for a Polish reader (`language` `pl`) and in
English for every other. The page words its scans as the `lang` it is opened
with (`en-gb` or `pl-pl`) says, and keeps that language in a cookie for the
form; the browser service opens either. The adapter opens it in English for
every reader until the map has the page's Polish scans from a live answer.

The browser step includes the API confirmation. If history retrieval fails,
`direct` returns the confirmed summary with the browser failure recorded.
Without TRAWL, `direct` asks only the API. A connection failure can retry the
complete HTTP lookup with a fresh proof. HTTP recognition always uses this
HTTP-only path.

## Data and limitations

The API supplies the current status, sender and delivery estimate. Its receipt
time is an instant; posting dates are calendar days. The estimate is the
delivery hours the portal shows, as instants on the Polish clock, else the
planned day. History rows retain facility-local clocks without an invented
offset, including international scans. Unknown history wording remains
unclassified.

DHL rewords a scan in place: a terminal arrival later gains its planned
delivery day. History scans carry no code, so the identity policy in
[identity.ts](identity.ts) lets a scan at the same instant and named place take
over its stored row, when the match is unique both ways. A scan without a place
takes it over when the map reads both wordings as one scan, as it reads a scan in
either language.

The DHL-specific helper uses TRAWL's native checkbox and audio solver.
A carrier-scoped copy retains the upstream algorithm and replaces its raw debug
output with fixed diagnostic events. Unsupported challenges and failed
verification retain the API summary. A solved checkbox alone is insufficient:
tracking requires a matching, nonempty history response. No recipient
postcode is needed for scan history. Each history lookup
solves Google's audio challenge, and Google refuses a host that asks too
often, so the catalog's `tracking.refresh` asks consumers to check a parcel at
most hourly, and two hours after a failed check.

Detection suggests eleven-digit waybills whose last digit is the check digit of
DHL Paket's Identcode: weights 4 and 9 alternate from the left over the first
ten digits. DHL does not document it for Poland, but every waybill archived
from its trackers passes it. Other accepted references, including
JJD licence plates, require the carrier to be named. Allegro Delivery numbers,
`AD` ones before a request and any the portal names as Allegro Delivery's, are
refused with the reason `other_carrier` because Allegro tracks that service.

## Testing

`npm run test:carriers:live -- carriers/dhl-ecommerce-pl` checks a synthetic
missing number. Set `DHL_ECOMMERCE_PL_TRACKING_NUMBER` privately to test a real
shipment. Also set `FLARESOLVERR_URL` to test full history through TRAWL.
