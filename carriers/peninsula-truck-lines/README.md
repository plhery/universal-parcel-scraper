# Peninsula Truck Lines

Peninsula Truck Lines is a less-than-truckload carrier in Washington, Oregon, Idaho and British
Columbia, based in Federal Way. Tracked by PRO through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://ptlprodapi.azurewebsites.net/api/track/public/{PRO}`, the lookup
   the tracking page at `www.peninsulatruck.com/track/?pro_number={PRO}` makes for a guest. It
   needs no cookie, token, key or browser. The reply is JSON: the shipment's PRO, its status
   line (`proStatus`) and its log (`shipmentLog`), under an `ok` status.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A PRO the lookup does not have is status 30001, "The search value could not be located". Any
  other error status is inconclusive. A 404, a 410 or a redirect is a moved route, and a block
  page or a browser check is a challenge.
- The reply must name the PRO asked. The lookup also finds shipments by other references: one
  found that way names another PRO, and a reference that matches several lists them without a
  PRO. Both are inconclusive and nothing from them is kept.
- The page's signed-in lookup, `/api/track/{PRO}`, and the keyed tracking API at
  `api.peninsulatruck.com`, which needs an API key and a token per customer, are not used.

## Notes

- The website refuses visitors outside North America with a firewall page; the lookup answers
  from anywhere.
- The reply's shape follows the page's code and Peninsula's tracking API guide, which share it.
  Each log row has a day, a 12-hour time, a short activity ("PICKUP", "DOCK", "DEL MFST") and a
  town with its state. No clock names its zone, so clocks stay wall clocks in `local_time`.
- The log lists the oldest row first; the result turns it round. A row with its day and no time
  orders only against another day's, so the rows whose clocks compare decide which way round the
  log is. Repeated rows appear once.
- The status line settles a delivery, a return, a problem and the hand-off to a partner carrier
  ("TENDERED TO … ON THEIR PRO …"), and a shipment without a staged row. Otherwise the newest
  staged row is ahead of it.
- A delivered status line ("DELIVERED ON {day}") keeps its day and nothing else, so a receiver it
  names is dropped. A log without a delivery row gets one on that day. A signer named after a
  row's activity is dropped too.
- The reply can name the shipper and the consignee with their addresses, and holds the bill of
  lading, the purchase order, a partner's PRO, the terminals and a delivery receipt flag. None of
  them is read; a partner and its PRO stay in the status line's wording.

## Limitations

- No estimate, service, sender, recipient, signature, weight or delivery receipt, and scans have
  no offset.
- A PRO reaches the adapter when it is filed under Peninsula Truck Lines or opened from a
  Peninsula link: PROs are bare runs of digits many carriers issue, so no rule claims them, and
  preflight does not ask it.

## Numbers

Peninsula tracks freight by its PRO, a run of digits with no published layout. The adapter
takes eight to twelve digits, the lengths the tracking API guide's examples show. No public page
shows a real one, so [`numbers.json`](numbers.json) has no samples and no rule detects them.

## Links

The home page's track form opens one shipment at `www.peninsulatruck.com/track/` with the number
in `pro_number`. The library reads the number from that address.

## Testing

`npm run test:carriers:live -- carriers/peninsula-truck-lines`, with
`PENINSULA_TRUCK_LINES_TRACKING_NUMBER` and optionally `PENINSULA_TRUCK_LINES_UNKNOWN_NUMBER` set
outside the repository.
