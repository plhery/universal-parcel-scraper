# Viapost

Viapost (ВИА ПОСТ) of Skopje is a courier in North Macedonia, separate from the national post. It
delivers web shops' orders and, as Magyar Posta's last-mile partner, AliExpress parcels from Hungary.
Recipients get a tracking link by Viber or text message.

## How it works

`direct` reads `https://www.viapost.solutions/Order/Track/<number>`, the page the tracking box on
`viapost.com.mk` opens, rendered on the server with no session, token or captcha. The page heads the
order with its number, which must be the whole number asked, then lists the scans oldest first. A
request that fails to reach the site gets one `retry` in the rest of the budget.

The tracker answers an order it does not know with HTTP 500 and the site's generic error page, the
MVC template's "Error." block in the site's layout. Only that page is not found; any other server
error, including that page under another status, is a transport failure. A Cloudflare check or
HTTP 401/403 is a challenge.

## Notes

- Each scan reads `<status> - <account>`. The status is the event's code and wording. The account
  is the sender for a new order and otherwise the courier or depot that recorded the scan; it names
  no place reliably and may be a private sender, so the adapter leaves it out.
- The page also shows the recipient's name, phone and address, the cash to collect and the sender,
  and some scans carry a comment, such as the Viber or text message sent to the recipient's phone.
  None of them is read.
- Times are `M/D/YYYY h:mm:ss AM|PM` on Skopje's wall clock and stay `local_time`. A notice sent at
  the same second as its scan repeats the scan; the copy is dropped.
- Viapost uses "НА ДОСТАВА" for a courier collecting from a shop and for a hand-over to another
  town's office as well as for a delivery round, so those read out for delivery too.
- The five-step bar at the top of the page is not marked in the HTML and is not read.

## Numbers

Viapost's own order ids are short bare digits. AliExpress parcels keep Magyar Posta's S10 number
(`RR…HU`), which postal detection claims; ELS delivers some of those too. Neither shape can name
Viapost, so select it explicitly. The samples and their sources are in
[`numbers.json`](numbers.json).

## Limitations

- No location, delivery estimate, weight or proof of delivery.
- A new system at `new.viapost.solutions` (`/api/Orders/track/<number>`) does not hold the older
  orders yet, while the links sent to recipients still open the old tracker.

## Links

`www.viapost.solutions/Order/Track/<number>` opens one order, and the library reads the number
from that address.

## Testing

`VIAPOST_TRACKING_NUMBER=… VIAPOST_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/viapost`
