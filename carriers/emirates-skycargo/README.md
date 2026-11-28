# Emirates SkyCargo

Emirates SkyCargo tracks freight on a master air waybill with Emirates' IATA prefix 176. Enter the whole waybill or
its eight-digit serial.

## How it works

1. `direct`: the three requests the [eSkyCargo](https://eskycargo.emirates.com/app/offerandorder/) page makes for a
   visitor without an account:
   - `POST /api/uaa/guest/oauth/token?productName=offerandorder` signs in as the public guest client the page's
     script uses for every visitor (`mercator`, with an empty secret) and returns a bearer token.
   - `POST /api/order/services/cargo/v1/orders/actions/search?view=summary` with the eleven digits finds the booking
     that holds the waybill. The reply names the waybill, which must be the one asked for.
   - `GET /api/order/services/cargo/v1/orders/b<booking reference>` opens the booking with its milestones.

## Notes

- Milestones keep each station's wall clock. The reply's `achievedUTC` sits hours away from the UTC times the same
  reply gives the flights, so it is not used.
- The reply lists the milestones in Emirates' own sequence, the latest first, and the history keeps that order: a
  station can file a flight's manifest after the flight left.
- The wording is the reply's own and names the flight, its date and its leg. A manifest keeps the stage before it; a
  pickup notice or a delivery away from the waybill's destination is a step on the way.
- The search answers a waybill without a booking with HTTP 404 and `BOOKING_NOT_FOUND`, which the page words "There
  is no matching result found for your shipment reference." It is read as not found. Older public waybills come
  back this way.
- A refusal (HTTP 403 or a verification page), a 401 for the guest client, a 404 without that code or an unreadable
  reply is a changed service, never a missing waybill.
- The result page names the waybill in its address fragment (`#/shipments/list?type=D&values=<eleven digits>`),
  which the link rule reads. That page finds a waybill only as eleven digits without a hyphen, which the catalog's
  link template cannot ensure, so the catalog links to the search page.

## Limitations

- Pieces, weights, customs status, the flight schedule and delay notes are not kept.
- When several bookings hold the waybill, the first one in force is read.

## Testing

`EMIRATES_SKYCARGO_TRACKING_NUMBER=… EMIRATES_SKYCARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/emirates-skycargo`
