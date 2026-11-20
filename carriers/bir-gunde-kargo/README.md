# Bir Günde Kargo

Bir Günde Kargo parcels are read from the carrier's tracking page on `takip.birgundekargo.com`.

Bir Günde Kargo is a Turkish parcel carrier based in Kağıthane, Istanbul, licensed by BTK. It
delivers e-commerce parcels, appointment and chilled deliveries through branches and agencies
across Turkey.

## Numbers

Its barcodes are a `B` and nine digits. The page also takes the order number the shop gave, and
then names the barcode. Both shapes are common elsewhere, so there is no detection rule.

## Retrieval

The form on the home page asks for a picture code beside the number and posts both to
`KargoApi/Gonder`, which answers with the address of the tracking page:
`/intranet/Tracking_kargo.asp?bgk_barkod={barcode}`, or `?alici_musteri_kodu={order}` for an order
number. That page needs no code, so the adapter opens it directly.

The page shows the status, the sender, the delivery estimate, the recipient and courier, and a
table of movements, oldest first, with wall clocks and no places. The adapter reads the movements
newest first, the sender and the estimate while it is still ahead; it leaves the recipient,
courier, vehicle and branch staff on the page. The barcode in the page's links must be the one
asked for; asked by order number, the page's order number must match and its barcode becomes the
canonical number.

An unknown reference gets the alert "Takip bilgilerinizi kontrol ediniz.", which is not found.
Once a parcel's round is over the page shows only "Kargonuzla ilgili süreç tamamlanmıştır." without
its movements or whether it was delivered, so that answer is inconclusive with the reason
`history_expired`.

"Devir - Tekrar Dağıtıma Çıkacak" carries a parcel over to another round after a round that did
not deliver it, a failed attempt as other Turkish carriers' "Devir" reads.

## Links

The tracking page's address carries the barcode or the order number.

## Testing

`BIR_GUNDE_KARGO_TRACKING_NUMBER` supplies a parcel still on its way.

```sh
npm run test:carriers:live -- carriers/bir-gunde-kargo/adapter.live.test.ts
```
