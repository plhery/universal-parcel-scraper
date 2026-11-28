# JDX Express

JDX Express (永创捷国际, jdxexpress.com), in Hong Kong, takes parcels in at its Hong Kong warehouses, trucks them
to Shenzhen, clears them through customs there and hands them to a courier in mainland China, such as STO or YTO.
Tracked through the Changyunda FlowLink system its tracking page asks.

## How it works

1. `direct`: one `POST http://flowlinkjdxexpress.changyunda.cn/APIAdmin/Account/TrackingSelectDomain?CNum={number}`
   with an empty body, as the page `www.jdxexpress.com/select.html?num={number}` sends it. `jdxexpress` is the
   firm's tenant on the system. It needs no cookie, token or account; the server refuses a POST without
   `Content-Length`, so the body is sent empty rather than left out.
2. `retry`: one more request when the first fails to reach the system or hangs. The first gets half of the budget.

- `ErrorCode` `NotExistsCNum` on the number asked is the system's only answer for a number it does not know. Only
  that is not found. A reply whose `code` is not 0 is inconclusive (the system reports its own exceptions so, with
  HTTP 200), a reply that does not list the number asked is refused, and any other status is a moved route or a
  request the system refuses.
- [`flowlink.ts`](flowlink.ts) holds the request, the reader and the adapter for any tenant of the system, each on
  its own `flowlink<tenant>.changyunda.cn` host. A tenant brings its subdomain, its tracking page, the zone of its
  rows and its status map; [`adapter.ts`](adapter.ts) is JDX Express's. A tenant whose rows mix several countries'
  clocks also reads each row's bracketed place for its location and zone, as [Meixi Express](../meixi/README.md)
  does.

## Notes

- `time` is a wall clock with no zone. Every row is read on Hong Kong's clock with `carrier` as the basis: the
  firm writes its Hong Kong and Shenzhen rows on one clock, and the rows the system relays from the courier in
  China are on China's, which has had Hong Kong's offset since 1992. A clock that would date a row after the
  lookup keeps its wall clock alone.
- The system's `CNCode` is kept as the scan's code; many rows have none, and the relayed rows all carry
  `GLT_DEPARTURE`, so the code alone stages only the codes whose every recorded text means one stage.
  `statuses.json` records each code with its text.
- The place in brackets at the start of a row becomes its location.
- `OtherName` and `OtherNum` name the courier in China and its number. They become the delivery carrier and the
  delivery tracking number when `OtherName` names one courier and that courier's rules offer the number.
- The relayed rows name couriers with their phones, and the branches' and hotlines' numbers. A courier named with a
  phone, a bracket that holds a phone or a contact, a person after their role, and each row from its first clause
  that gives a phone, asks the reader to call or follows the news with a courtesy are left out.
- The reply also carries the recipient's masked name and address and the last four digits of their phone
  (`OrderRecipientName`, `OrderRecipientAddress`, `phone4`). They are never read.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- The system answers a waybill and the number it was handed on under alike; the adapter keeps only the reply whose
  `CNum` is the number asked.

## Numbers

JDX Express's waybills seen so far are YCJ, seven digits and HK, a shape no other carrier's rule or sample takes,
so detection offers JDX Express for it and HTTP recognition asks the system about it. The adapter answers explicit
selection for any number of 6 to 30 letters and digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page is served over plain HTTP only, so the catalog gives no tracking link or search page.

## Testing

`npm run test:carriers:live -- carriers/jdxexpress` tracks the public sample, or the number in
`JDXEXPRESS_TRACKING_NUMBER`, and checks an invented waybill, or the one in `JDXEXPRESS_UNKNOWN_NUMBER`, reads as
not found.
