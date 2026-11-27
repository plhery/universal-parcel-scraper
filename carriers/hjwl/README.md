# HJWL

HJWL (汇捷物流), a logistics firm in Hebei, China, enters each parcel's nodes by hand in its own system and
lists them on a public query page at hjwl.ltd. Tracked through the service that page asks.

## How it works

1. `direct`: one `GET https://www.hjwl.ltd/api/logisticsNodes/findByNumber?number={number}`. It needs no cookie,
   token, account or browser; the query page's sign-in header is not needed. The reply is JSON: `code` 200,
   `success` and the number's nodes in `data`, oldest first, each with the number, a short status, a message and
   `createTime`. The page itself asks `/api/logisticsNodes/list1`, which pages the same nodes.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets half of the
   budget, so the retry fits in the rest. The server is sometimes slow to accept a connection from abroad, so
   the default budget is 20 seconds.

- `code` 200, `success`, `msg` 操作成功 and no node is the answer for a number the service holds nothing under,
  which is not found. Another code, or no node with another message, is inconclusive; HTML is a browser check
  or a changed route, and a non-200 reply is a moved route or a request the service refuses.
- Every node must carry the whole number asked. A reply with another number's node is refused whole: a service
  that ignored the number would list every parcel's nodes.
- The adapter never sends an empty number, for the same reason.

## Notes

- The operator enters each node with its clock, which has no zone. It is dated on China's clock, the firm's, with
  `carrier` as the basis. A clock that would date a node after the lookup keeps its wall clock alone. Nodes at one
  clock keep the reply's order, the later one newer.
- The status is kept as the scan's code and sets the stage through `statuses.json`; the message is the wording.
  A status the map does not know goes through the shared wording rules, then the message.
- Messages are typed by hand, so a courier's name and phone, a signatory or any other contact is taken out of the
  wording; a message left empty shows the status.
- Places are only in the messages' words, so no node has a location.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- The clock is the one the operator typed, which may be later than the step itself.

## Numbers

HJWL's numbers are HJWL and fourteen digits, a date and time. No other carrier's rule or sample takes that shape,
so detection names HJWL for it. The adapter answers explicit selection of any number of 6 to 40 letters and
digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/hjwl` tracks the public sample, or the number in `HJWL_TRACKING_NUMBER`,
and checks an invented number, or the one in `HJWL_UNKNOWN_NUMBER`, reads as not found.
