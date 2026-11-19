# Yandex Delivery

Yandex Delivery (Яндекс Доставка), ООО «Яндекс.Доставка» of Moscow, is Yandex's Russian delivery
service: courier, pickup-point and parcel-locker delivery for shops and people, with express city
deliveries by partner couriers. Boxberry's site now sends visitors to a Yandex Delivery page headed
"Boxberry теперь в Яндекс Доставке", so Boxberry is one of its names.

## Numbers

Its tracking page takes a tracking or order number of 6 to 40 Latin letters, digits and hyphens,
gives the layout as `LO-` and nine digits, and shows one example. Two letters and nine digits is
also the shape of GLS Italy's numbers, so there is no detection rule; the adapter answers an
explicit selection. It upper-cases the number, which the page reads either way.

## Retrieval

The tracking page's form sends `order_tracking_id` by GET and the server renders the result,
without a session, a cookie or a key. The adapter sends the same request.

A known number gets HTTP 200 with a heading "Заказ <number>" and the history as a list, oldest
first. The adapter requires that heading to be the whole number asked. An unknown number gets
HTTP 404 with the tracker's notice "Заказ <number> не найден", which the adapter reads as not
found only when it names the number asked; a 404 without it, or any page that is not the
tracker, stays a failure. Yandex sends a visitor it suspects of being a robot to its SmartCaptcha
page, which is a challenge.

The scans' clocks carry no zone, and the page shows them for places across Russia, so they are
kept as wall clocks. A scan the page shows without a clock keeps none, in its place. The line
under a scan is a place, except under the waiting, storage, return-date and cancellation scans,
where it is a deadline or a reason and is left out, as is the card above the history with the
pickup deadline.

## Stages

The map follows the page's scan wordings and the statuses its "Что значат статусы доставки"
section explains. A parcel left uncollected is cancelled, then goes back through the point it was
dropped at and waits there for the sender, which is a return; a disposed order is an exception.
Changes of the storage deadline or return date, and a delayed delivery, keep the stage before
them.

## Links

`https://dostavka.yandex.ru/ndd/tracking/?order_tracking_id={trackingNumber}` opens the tracking
page on the number. A pasted dostavka.yandex.ru tracking link with an `order_tracking_id` names
Yandex Delivery.

## Testing

`npm run test:carriers:live -- carriers/yandex-delivery` looks up the page's example and an
unknown number; `YANDEX_DELIVERY_TRACKING_NUMBER` and `YANDEX_DELIVERY_UNKNOWN_NUMBER` replace
them.
