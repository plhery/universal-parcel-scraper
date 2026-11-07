# Seino Super Express

Native guest tracking covers SSX slips. Seino Transportation is a separate company with its own
numbers and tracker; the shared Seino brand does not establish ownership.

## Retrieval

`direct` submits the [official SSX form](https://www.seino.co.jp/ssx/) to
`inquire.trc.ssx.seino.co.jp/inquire/main.jsp`, decodes Shift_JIS and binds the whole displayed
slip. It follows the public detail action with the fresh row parameters and guest cookie.
That state stays within the lookup. Customer-code searches and R-smile accounts are separate.

The detail view supplies movement scans absent from the two-row summary. Its transaction
clocks take precedence over the summary's current-status clock. Only status, source clock and
facility are retained; staff, vehicle and contact fields are omitted.

## Numbers and clocks

The form accepts ten-, thirteen- and fifteen-digit slips and displays them padded to fifteen.
Comparison uses that exact padding; no number rule or HTTP recognition claims shared numeric
layouts. Explicit selection and supported named handoffs can use the adapter.

Scan clocks omit the year. They stay in `provider_time_text` in source order, newest first;
the retention notice supplies no reliable calendar year. `tracking.localClocks` lets consumers
retain this direct history, and `history_truncated` leaves provider enrichment available.
Delivery-estimate fields with unread values are flagged separately.

## Testing

Set `SEINO_SUPER_EXPRESS_LIVE_NUMBER` and optionally `SEINO_SUPER_EXPRESS_LIVE_UNKNOWN` outside Git,
then run `npm run test:carriers:live -- carriers/seino-super-express`.
