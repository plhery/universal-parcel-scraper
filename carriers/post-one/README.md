# Post One

Public guest history for Post One's own item references. The Bulgarian operator
consolidates parcels and hands them to a delivery partner abroad. Partner references
accepted by the same portal retain their issuer detection and are outside this adapter's
input scope.

## Retrieval

A bounded GET reads `/en/track?code={trackingNumber}` without a session or secondary input.
The labelled item number must match the complete requested reference before any scans are
read. Only the observed empty redirect to the official English home page is not found;
other redirects, refusals, verification pages and malformed replies remain distinct.
One network-only retry shares the caller's deadline.

Only reached, dated logistics rows become events. The official icons and their status
labels establish the code mapping. The milestone view is marked partial so the delivery
partner and enabled providers can supply detailed scans. Unknown codes keep a generic update;
recipient prose and unfinished progress rows are excluded.
Every source row is checked before deduplication and the output cap.

Scan clocks retain their displayed wall time and precision. Archived and current pages
disagree on a clock without stating a zone, so the adapter supplies no inferred instant,
delivery instant or estimate.

## Handoffs and recognition

SPS Slovakia is a named delivery handoff only when its explicit name, whole partner number
and official tracking link agree. That relationship does not confirm the partner's current
history; the consumer still asks the partner directly. Other partner mappings and partner
aliases require separate evidence.

HTTP recognition uses the same narrow own-reference gate and identity checks. The existing
number rule remains a low-confidence suggestion because another carrier shares its shape.
A confirmed item with no dated rows is known without supplying history. Enabled universal
providers remain available for recovery and completion.

## Testing

Set `POST_ONE_TRACKING_NUMBER` and optionally `POST_ONE_UNKNOWN_NUMBER` outside the
repository, then run `npm run test:carriers:live -- carriers/post-one`.
