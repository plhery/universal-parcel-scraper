# Meixi Express

Meixi Express (美西速运, 美西环球速运; J-FIVE GLOBAL INC), in Los Angeles, takes parcels in at its warehouse there,
flies them to China, clears them through customs and hands them to a courier in China, such as SF Express.
Tracked through the Changyunda FlowLink system its tracking page asks, with the reader JDX Express also uses.

## How it works

1. `direct`: one `POST http://flowlinkj5ex.changyunda.cn/APIAdmin/Account/TrackingSelectDomain?CNum={number}` with
   an empty body. `j5ex` is the firm's tenant on the system. It needs no cookie, token or account. The page
   `www.j5ex.com/select.html?num={number}` asks the same route with a GET over HTTPS; the system answers both.
2. `retry`: one more request when the first fails to reach the system or hangs. The first gets half of the budget.

- `ErrorCode` `NotExistsCNum` on the number asked is the system's only answer for a number it does not know. Only
  that is not found. The request, the reader and the failure kinds are FlowLink's, in
  [`../jdxexpress/flowlink.ts`](../jdxexpress/flowlink.ts); [`adapter.ts`](adapter.ts) is Meixi Express's tenant.

## Notes

- `time` is a wall clock with no zone, and the brackets a row opens with decide its clock. The firm's name
  (【美西速运】), the route (【美国-中国】) and a place in the United States head the US side's rows, which the firm
  writes from Los Angeles: they are on Los Angeles' clock, with `place` as the basis when the brackets name Los
  Angeles and `carrier` otherwise. The flight's departure is the last of them. From the parcel's arrival in China
  the brackets name China or a place there, and the rows are on China's clock. A row without brackets is on Los
  Angeles' clock, unless the system's code puts it on China's leg (import, the courier there, the signature).
- The firm's name and a route are not kept as a location; a place is.
- `OtherName` and `OtherNum` name the courier in China and its number, which the page shows as the hand-off after
  clearance. They become the delivery carrier and the delivery tracking number when `OtherName` names one courier
  and that courier's rules offer the number.
- The reply also carries the recipient's masked name and address and the last four digits of their phone
  (`OrderRecipientName`, `OrderRecipientAddress`, `phone4`). They are never read.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- The page can also look parcels up by the recipient's phone. The adapter does not.

## Numbers

Kuaidi100's example number is eleven bare digits, a shape many carriers' numbers share, so no rule offers Meixi
Express; the adapter answers explicit selection for any number of 6 to 30 letters and digits. The sample and its
source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/meixi` tracks the public sample, or the number in `MEIXI_TRACKING_NUMBER`,
and checks an invented number, or the one in `MEIXI_UNKNOWN_NUMBER`, reads as not found.
