# Oversea Express

Oversea Express (波音速递, overseaex.com), based near Boston, takes parcels in at its US warehouse, flies them to
China and hands them to a courier there after customs. Tracked through the search of its DsyExpress site.

## How it works

1. `direct`: one `GET https://www.overseaex.com/index.php?c=index&f=search&sn={number}`, as the site's tracking box
   sends it. It needs no cookie, token or account.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget.

- A waybill answers HTTP 200 with a table of rows, each a wall clock and a text, newest first, with the rows of the
  courier in China merged in. The platform's tips page with 运单信息不存在 is the only not-found; the tips page with
  any other message is inconclusive, a redirect or any other status is a moved site, and a page that is neither is a
  browser check or a changed page.
- The reply does not echo the number: the scans are those of the number in the request. No redirect is followed.
- [`dsyexpress.ts`](dsyexpress.ts) holds the request, the reader and the adapter for any site on the platform. A
  tenant brings its host, its status map and the zones of the places its line-haul rows name;
  [`adapter.ts`](adapter.ts) is Oversea Express's.

## Notes

- The rows carry no zone. The platform writes its own rows on its server's clock, which is China's: the server's
  own stamps are UTC+8, and the warehouse's rows at 01:41 and 02:17 read as the afternoon before in Boston on it.
  The couriers in China write theirs on the same clock. These rows are on China's clock with `carrier` as the
  basis. A line-haul feed some tenants use writes rows that open with 【<country> - <town>】: they are on that
  town's clock with `place` as the basis when the tenant knows its zone, China's towns always, and the feed's
  rows that are one bracket alone keep their wall clock alone. A clock that would date a row after the lookup
  keeps its wall clock alone.
- The town a relayed row opens with before a bar, as in `北京市|北京市【…】`, becomes the location and leaves the
  text; `original_description` keeps the row as written.
- The table's header, as in `物流状态（百世快递：…）`, or the courier's pickup row, as in `顺丰速运已揽件单号:…`,
  names the courier in China and its number. They become the delivery carrier and the delivery tracking number
  when the catalog has that courier, its rules offer the number and the number is not the waybill. BEST Express
  is not in the catalog, so the sample names none.
- The relayed rows name couriers and signers, with mobiles, branches' landlines and hotlines. A courier named with
  a phone or after their role, a bracket or parenthesis that gives a contact, a station's address, where a
  locker stands, the person who signed and each clause that gives a phone are left out, and a row stops at its
  first courtesy.
- `statuses.json` records each text with its brackets, digits, towns and stations as ….

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- No public sample shows a parcel handed to a courier the catalog has.

## Numbers

Oversea Express's waybills seen so far are OE and eleven digits, a shape La Poste's rule takes for two characters
and eleven digits, so detection does not name Oversea Express, and the adapter answers explicit selection for any
number of 6 to 30 letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`www.overseaex.com/index.php?c=index&f=search&sn={number}` opens the reply for the number. The search page is the
home page, with its tracking box.

## Testing

`npm run test:carriers:live -- carriers/overseaex` tracks the public sample, or the number in
`OVERSEAEX_TRACKING_NUMBER`, and checks an invented waybill, or the one in `OVERSEAEX_UNKNOWN_NUMBER`, reads as not
found.
