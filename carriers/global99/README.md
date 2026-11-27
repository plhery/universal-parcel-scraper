# Global Courier International

Global Courier International (全球速运国际物流, also 全球特快国际物流 and Global Express International Logistics),
registered in Hong Kong, ships parcels to China from branches abroad, such as Paris and Bali. Its parcels are
cleared at Shanghai and handed to ZTO Express or ZTO Freight for delivery. Its site is global-99.com. Tracked
through the site's online query page.

## How it works

1. `direct`: one `GET http://www.global-99.com/source/article.php?act=search&tid=56&ydh={number}`, the page's
   search form. It needs no cookie, token or account. The site's certificate has expired, so the page is asked
   over plain HTTP, as the site's own links do. The page is HTML: the number in its search box and the rows under
   it, newest first.
2. `retry`: one more request when the first fails to reach the page or hangs. The first gets half of the budget,
   so the retry fits in the rest.

- The page echoes the number only in its search box; a page for another number is refused.
- An alert saying 请输入正确的运单号 and no result table, for the number asked, is the page's answer for a number
  it holds nothing under, which is not found. A table without rows is a number without a history yet. A page with
  neither, or without the search box, is a browser check or a changed page, and a non-200 reply is a moved page.
- The page takes the number from its address, but only over plain HTTP, so the catalog gives no tracking link.

## Notes

- Clocks have no zone. The firm's own rows end their clock in dots. Once the firm hands the parcel to a courier in
  China, it copies that courier's rows, without dots, above the hand-off row.
- An own row that ends on a place, as `PARIS - FRANCE` or `SHANGHAI - CHINA, PEOPLES REPUBLIC`, keeps it as the
  location and is dated on its country's clock when the country keeps one, with `place` as the basis; the row
  keeps its text whole in `original_description`. A row of the Bali branch, which names it as 【Bali Island】, is
  dated on Bali's clock. Other own rows, such as the hand-off and the leg at sea or in the air, keep their wall
  clock alone, and a consumer dates them by the rows around them.
- The courier's rows are dated on China's clock, with `destination` as the basis. Their courier, mobiles,
  depot phones, hotlines and the courtesy after them are taken out; the station or city they name is the
  location.
- The hand-off row names the courier and its number, as 转国内中通快递，单号：…. That courier is the delivery
  carrier, with that number, when the number is one ZTO Express or ZTO Freight tracks. A hand-off or a place in
  China gives China as the destination, and the oldest place abroad the origin.
- `statuses.json` records each text with brackets, the hand-off number and the courier's stations as ….

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- An own row in a country with several zones keeps its wall clock alone.

## Numbers

Waybills are TK and twelve digits on the samples. No other carrier's rule or sample takes that shape, so detection
offers Global Courier International for it, and the adapter answers explicit selection of any number of 6 to 30
letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/global99` tracks the first public sample, or the number in
`GLOBAL99_TRACKING_NUMBER`, and checks an invented number, or the one in `GLOBAL99_UNKNOWN_NUMBER`, reads as not
found.
