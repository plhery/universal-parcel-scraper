# Yol Kargo

Yol Kargo is a Turkish parcel carrier licensed by BTK, with branches and agencies and its own
fleet in Istanbul. yolkargo.com is not its site. Tracked through the lookup its tracking form
opens.

## How it works

1. `direct`: `GET https://yolkargo.com.tr/kargo?q={number}`, which the form's
   `kargo.php?q=` redirects to. It answers with a redirect to the system that holds the number,
   and lists that system in its body as JSON (`[{"url": …, "cpy": …}]`):
   - `cpy` 4 is Yol Kargo's own network. The adapter opens its shipment page, an ASP.NET page on
     `185.130.59.105/Elci2017/KargoSorgulaDetay.aspx?Guid=…` over plain HTTP, and reads the
     movements.
   - `cpy` 1 is a shipment Yol Kargo handed Aras Kargo. The redirect opens Aras Kargo's page for
     it under Yol Kargo's account, the same for every visitor. Its summary frame gives Aras
     Kargo's own number once it names Yol Kargo's number as the sender's waybill, and the
     adapter tracks that number with the [Aras Kargo](../aras-kargo/README.md) adapter.
   - An empty list sends the browser to Ful Kargo's tracker. When that says it does not know the
     number either, the shipment is not found.
2. `retry`: a lookup that fails to reach the service, or hangs, is sent once more within the
   budget. The first try gets half of it.

No key, account or CAPTCHA is needed.

## Notes

- The shipment page and every movement on it must name the number asked, and the page's header
  must name Yol Kargo: the system also serves other networks.
- Clocks carry no offset and stay local wall times, read in the catalog zone.
- Wording is mapped in [statuses.json](statuses.json). `TESLİM GİRİŞİ`, the delivery entered at
  the branch, is the delivery.
- A shipment Aras Kargo carries comes back as Aras Kargo's result, with `delivery_carrier` and
  `delivery_tracking_number` naming it. It keeps what that adapter keeps, such as the places,
  the planned day and the masked recipient.
- On Yol Kargo's own page, the recipient's masked name, the goods and the proof-of-delivery
  picture are not read.

## Limitations

- Another `cpy`, or a lookup that lists more than one system, is inconclusive.
- Yol Kargo's own page gives no place or estimate.

## Numbers

Yol Kargo's shipment numbers are nine digits in the samples, a length many carriers share, so
there is no rule. The adapter takes seven to twelve digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The catalog reads the number from `q` on `yolkargo.com.tr/kargo.php`.

## Testing

`npm run test:carriers:live -- carriers/yol-kargo`, with `YOL_KARGO_TRACKING_NUMBER`,
`YOL_KARGO_ARAS_TRACKING_NUMBER` and `YOL_KARGO_UNKNOWN_NUMBER` set outside the repository.
