# J&T Express Brazil

The domestic Brazil network has its own tracker, separate from the Southeast Asian J&T
operations and J&T Cargo. Native retrieval uses its public number-only guest form through
TRAWL. The page owns request signing, Tencent verification and the final tracking POST.

The scoped browser helper matches the jigsaw's native-image texture and silhouette, measures
the piece's movement against the knob, and keeps generation checks through the held drag.
The drag is one cursor move: the service's browser takes most of a second over each move,
however short.
An ambiguous image abstains. It permits at most two drags and two bound tracking requests,
within the caller's deadline, and closes its fresh context. The helper abstains often, within
seconds and before any drag, so the adapter asks it up to twice more while the budget left still
holds another solved run: each new context draws another image. No provider
is asked about a J&T Brazil parcel ([COVERAGE.md](../../providers/COVERAGE.md)). Every answer
costs a solved puzzle, so the catalog asks for a refresh
at most every half hour, and an hour after a failed one, out for delivery included.
Challenge diagnostics distinguish an uncertain image or a changed drag from verification
that did not finish, using the final helper attempt's result.

The request and positive reply must name the whole domestic waybill. A successful reply with
an empty list, or with no data as for a waybill J&T has no record of yet, is no history rather
than a confirmed missing waybill. Malformed replies, verification
refusals, rate limits and other HTTP failures stay distinct. A refusal that is neither a
challenge nor a rate limit stays a schema failure that keeps J&T's code and flag. An
unavailable tracking page or browser service is a transport failure. The adapter
retains every dated milestone and its provider code, preserving offset-free wall clocks.
Each scan is worded with the line the tracking page shows for it, its bracketed city becoming
the place: J&T's status reads "Em transferencia" for every arrival and departure alike, while the
line names the centres. A collection's line names the courier, masked, then adds a contact note
with a phone number; both are dropped. A line of another shape, which could name a recipient or a
signer, gives way to J&T's status.
Staff, recipient fields, free-form remarks, signatures and proof-of-delivery data are omitted.

## Numbers

The guest flow answers fifteen-digit domestic waybills beginning with 888 or 99988. Every 888
waybill seen so far begins with 8880 or, in its next series, 8881, and no other carrier's
numbers begin with 8880, 8881 or 99988, so high-confidence rules file both series under J&T
Brazil ahead of BRT's and Yunda's fifteen digits. There is no HTTP recognizer, and a
browser check takes longer than recognition allows, so the rules file the number rather than
suggesting it: a parcel J&T Brazil does not know falls back to the other carriers.
Other aliases and the CPF/CNPJ, account and proof-of-delivery branches are outside this adapter.

Samples and provenance live in [`numbers.json`](numbers.json). The current portal's query
only opens the form; the browser helper fills it instead of assuming the query submitted it.

## Testing

`npm run test:carriers:live -- carriers/j-and-t-br`, with `JT_BR_TRACKING_NUMBER` and optionally
`JT_BR_UNKNOWN_NUMBER` supplied outside the repository. Use the compatible TRAWL service
with the J&T Brazil helper.
