# CautCurier

CautCurier is an urgent and same-day courier in Timișoara and Oradea, Romania. Its site is
cautcurier.ro.

## How it works

`direct` asks `https://tracking-api.cautcurier.ro/api/Tracker/GetOrderDetails?awb=<AWB>`, the
lookup the tracking page calls, with no session, token or account. Its JSON carries the order's
id, which must be the AWB asked, its current type, the masked sender and recipient, its weight and
its events, each a type and a Unix time. The server answers an AWB it has no order for with HTTP
500 and the message "Object reference not set to an instance of an object." alone; only that reply
is a missing order, and any other 500 is a server fault. A request that fails to reach the server
gets one `retry` in the rest of the budget.

The events keep the type as their code and take the English label the tracking page shows for it.
Their times are instants. The order's own type gives the current status, as the page shows it. The
sender and recipient are left out.

## Numbers

The AWB is the order's id, digits only. Digits alone match many other carriers' numbers, so there
is no rule and the carrier needs explicit selection. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page opens numbers from its `awb` parameter.

## Limitations

No place, estimate or proof of delivery. The order's sub-status, such as a refusal or a wrong
address, comes as an id the page names from its own list; the adapter does not read it. Only
the created and cancelled-by-office types have been seen in a reply; the others follow the
tracking page's script.

## Testing

`npm run test:carriers:live -- carriers/cautcurier`

The live test tracks the public sample in `numbers.json`; `CAUTCURIER_TRACKING_NUMBER` tracks
another AWB, and `CAUTCURIER_UNKNOWN_NUMBER` checks the not-found answer.
