# ZTO Express

Chinese domestic ZTO waybills use the [official tracker](https://www.zto.com/check).
Number shapes overlap other carriers; only a matching response confirms ownership.
ZTO International uses a separate network and tracker.
Its waybills, 771 and eleven digits, are tracked as [ZTO International](../zto-international/README.md).

The adapter first posts to `hdgateway.zto.com/batchGetTrace`. A verification response
can fall back to the bundled TRAWL image. The page obtains a Dingxiang challenge
from `mapi.zto.com/captcha/image2`, solves a slider and, when requested, clicks
Chinese characters in order using local OCR. It asks for another puzzle when it cannot
read one, at most twice, and once for each refused answer, since Dingxiang shows the
same picture again after a refusal. The page submits its own verification
token and repeats tracking in the same context. Tokens and recipient details stay
inside that context.

Verification can fail or exceed the lookup budget. The challenge reason says where it
stopped, from the [shared set](../../ARCHITECTURE.md), and the service's `zto.verification`
warning has each puzzle's detail. Enabled universal providers
remain available for those failures and for fuller history: the public PC tracker
suppresses earlier traces even after verification. The adapter marks its history
as incomplete and keeps the carrier's epoch scan clocks. A trace's label in Chinese shows
the English of its type, and takes over the row stored in Chinese.

HTTP recognition does not ask ZTO: its gateway challenges a server's probes, and most
twelve-digit numbers it would be asked about belong to FedEx, which issues the same shape.
Browser recognition asks it about fourteen-digit waybills beginning with 73, the series
of its archived waybill links, or 79, a series its tracker answers with domestic scans
too. It runs the page's verification alone, which fits the browser probe's budget. A
matching reply confirms the number; GLS Netherlands prints some fourteen-digit runs
beginning with 73 too, and Hermes Austria some beginning with 79.

The legacy image endpoint does not supply the page's plain-code challenge. Mobile
H5 tracking requires a signed-in ZTO account. The
[Android app](https://www.zto.com/) (`cn.beekee.zhongtong`) also gates its native
waybill-detail screen on saved login state. Its `getBill` history, order details
and phone verification belong to that account flow; they are separate from the
public PC tracker. The unauthenticated ZTO International route does not establish
domestic shipment ownership.

Forwarders that hand parcels to ZTO, such as [ESOWAY](../esoway/README.md), copy ZTO's
sentences into their own trackers, with the courier's name and mobile, the branch's
phones and the pickup point. [`relayed.ts`](relayed.ts) keeps such a sentence without
them, and the city its brackets open with as the place.

## Testing

Set `ZTO_TRACKING_NUMBER` and `FLARESOLVERR_URL` privately, then run
`npm run test:carriers:live -- carriers/zto`.
