# Passerby A Express

Passerby A Express (顺捷美中速递, passerbyaexpress.com), based in Tustin, California, takes parcels in at
its US warehouse, flies them to a port of clearance in China and hands them to SF Express. Tracked through the
search of its DsyExpress site, with the reader in [`carriers/overseaex`](../overseaex/README.md).

## How it works

1. `direct`: one `GET https://www.passerbyaexpress.com/index.php?c=index&f=search&sn={number}`, as the site's
   tracking box sends it. It needs no cookie, token or account.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget.

- The platform's tips page with 运单信息不存在 is the only not-found; the reader in
  [`dsyexpress.ts`](../overseaex/dsyexpress.ts) says how every other answer reads.
- The reply does not echo the number: the scans are those of the number in the request. No redirect is followed.

## Notes

- The rows carry no zone. The platform writes its own rows on its server's clock, whose own stamps are UTC+8, and
  SF Express writes its rows on China's clock, so every row is on China's clock with `carrier` as the basis. A
  clock that would date a row after the lookup keeps its wall clock alone.
- The platform's row `顺丰速运已揽件单号:…` gives SF Express's waybill, which becomes the delivery tracking number
  when SF Express's rules offer it.
- SF Express's rows name the courier with a mobile, give a station's address and end on a courtesy. Those parts
  are left out.

## Limitations

- No delivery estimate, weight, service name, location, sender or recipient.

## Numbers

Passerby A Express's waybill on the public sample is twelve bare digits, a shape many carriers' numbers share, so
detection does not name it, and the adapter answers explicit selection for any number of 6 to 30 letters and
digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`www.passerbyaexpress.com/index.php?c=index&f=search&sn={number}` opens the reply for the number. The search page
is the home page, with its tracking box.

## Testing

`npm run test:carriers:live -- carriers/shunjie` tracks the public sample, or the number in
`SHUNJIE_TRACKING_NUMBER`, and checks an invented waybill, or the one in `SHUNJIE_UNKNOWN_NUMBER`, reads as not
found.
