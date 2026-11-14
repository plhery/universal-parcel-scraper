# Yandex Delivery

Yandex Delivery parcels use enabled universal providers. There is no dedicated adapter.

Yandex Delivery (Яндекс Доставка), ООО «Яндекс.Доставка» of Moscow, is Yandex's Russian delivery
service: courier, pickup-point and parcel-locker delivery for shops and people, with express city
deliveries by partner couriers. Boxberry's site now sends visitors to a Yandex Delivery page headed
"Boxberry теперь в Яндекс Доставке", so Boxberry is one of its names.

## Numbers

Its tracking page takes a tracking or order number, gives the layout as `LO-` and nine digits, and
shows one example. Two letters and nine digits is also the shape of GLS Italy's numbers, and with
only that example to go on there is no rule.

## Why there is no adapter

The tracking page's form sends the number by GET. With only the page's example to check its replies
against, there is no adapter.

## Links

`https://dostavka.yandex.ru/ndd/tracking/?order_tracking_id={trackingNumber}` opens the tracking
page on the number. A pasted dostavka.yandex.ru tracking link with an `order_tracking_id` names
Yandex Delivery.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
