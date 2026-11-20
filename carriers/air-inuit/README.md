# Air Inuit

Air Inuit, the airline of Nunavik owned by Makivvik, carries cargo between the Inuit communities
of northern Quebec and Montréal, Québec City and other stations of its network. Tracked through
the shipment tracking page of its website.

## How it works

1. `direct`: `GET https://www.airinuit.com/cargo.php?id={serial}&lang=2`, the JSON endpoint the
   tracking page's script reads, with no cookie, token or key. `lang=2` asks for English.

- The reply names the waybill by its prefix, `466-` and the issuing station, and its serial. Both
  must match the waybill asked.
- An unknown waybill gets an empty `status` and a blank record. Another status is inconclusive.
- Cloudflare fronts the site: its challenge page, even with HTTP 200, is a challenge, and a 429 is
  rate limited.
- There is no recognition. No detection rule names Air Inuit, so preflight never offers it a
  number.

## Notes

- The reply lists the waybill's lines of goods, each with the whole history, numbered by kind in
  `statuID`. The adapter stages lines by that number and keeps once the lines the goods share.
- A shipment received at a station other than its destination is in transit; received at its
  destination it waits for the consignee.
- Lines carry the station's day and second. Air Inuit's stations keep Eastern time, so each line
  gets an instant in `America/Toronto` beside its wall clock.
- A flight's lines are placed at its departure station, the others at the station their wording
  names. The pick-up names none.

## Limitations

- The origin, destination, weight and pieces of the waybill and its goods are not kept. There is
  no sender, recipient or proof of delivery.
- Waybills of other airlines that Air Inuit carries on, which its form takes with their own
  prefix, are refused: no public one is known to check the reply against.

## Numbers

An Air Inuit air waybill is the airline's 466 prefix, the three letters of the station that
issued it and an eight-digit serial, printed with dashes between them. The adapter takes the
serial alone or after `466`, with or without the station, and asks for the serial. The samples
and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/air-inuit`, with `AIR_INUIT_TRACKING_NUMBER` and
optionally `AIR_INUIT_UNKNOWN_NUMBER` set outside the repository.
