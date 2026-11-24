# Trusk

Trusk, of Saint-Ouen, delivers and installs items over 30 kg for online shops and retailers
across France, with independent transport partners.

## Retrieval

Trusk's message to the recipient links the order page, `track.trusk.com/<order>` (older
messages add a language: `/fr/<order>`). The page's script reads
`GET track.trusk.com/api/order/<order>`, without a session, token or CAPTCHA, and the adapter
reads the same JSON: the order's steps, each with its state and the instants it happened at in
UTC, the booked delivery slot, the retailer and the goods' weight.

- The order id is case-sensitive, and a tracking number keeps it only in capitals, so the
  adapter needs the order link (`trackingUrl`) and reads the id from it. A pasted link gives
  both. Without the link, other sources are asked.
- The reply does not repeat the order id; the request names it.
- A step is staged by its key (`dropoff_completed`), shown with the page's French label. A
  failed or cancelled step that would move the order on is a problem instead.
- The slot is the estimate once it is booked. While the recipient still has one to choose, the
  order has none.
- An unknown id gets HTTP 404 with `{"error": "order_not_recoverable"}`, and an order the
  lookup no longer holds gets `{"error": "Not Found"}`; both are not found. Any other refusal
  stays open.
- The recipient's masked name, phone and address, the retailer's order number, the driver,
  the packages and the delivery options are never read.

## Limitations

- Older orders keep a time on only some steps, and that time is the same for every order,
  later than the delivery: the lookup rewrote them. The adapter keeps the times it gives.
- An order id without a digit does not pass as a tracking number, so such an order cannot be
  added.

## Numbers

The order id is six to 32 letters, digits, hyphens and underscores. Nothing in it is Trusk's
own, so there is no detection rule; the link names the carrier.

## Testing

```sh
npm run test:carriers:live -- carriers/trusk
```

`TRUSK_TRACKING_URL` checks another order link, and `TRUSK_UNKNOWN_ORDER` another unknown id.
