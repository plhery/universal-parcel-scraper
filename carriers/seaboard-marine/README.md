# Seaboard Marine

Seaboard Marine is the Miami container line serving the Caribbean and Central and South America.
Tracked through the equipment search on its website, for a container.

## How it works

1. `direct` opens the page the website's equipment search opens,
   `https://www.seaboardmarine.com/tracking-results/?eq_number=SMLU+123456&vin_number=`: the
   container's owner code, a space and its serial without the check digit, as the search form
   takes it. The page is a whole WordPress page of about a megabyte, with the container's last move
   in a card near its end; only the form and the card are parsed.
2. `retry` asks once more when the request did not reach the website.

No account, cookie, token or CAPTCHA is needed.

## Notes

- The form must echo the search, and the card must name the container asked with its check digit.
  The search takes no check digit, so a card whose check digit differs names another container.
- The card's notice "No Equipment Information Is Available At This Time." is a container Seaboard
  Marine does not track. A card of dashes, as the page shows before any search, is its answer for a
  number it holds no record of; a failure behind the page could show the same, so that answer is
  inconclusive (`portal_not_found`). A page without the form, or a card of another layout, is a
  changed reply.
- The card shows the container's last move alone, so the history is always marked truncated.
- A move says what happened to the container, its direction and whether it is full, as
  "Equipment At Puerto Limon, Costa Rica Moving Import Empty." or "Equipment Dispatched To Customer
  Moving No Direction Empty.", or names the vessel and voyage it is on board. A full container at a
  place on its way in or out, or on board, is in transit. Other moves are left without a stage: one
  move does not tell an empty container's trip or a hand-over's step. The wordings are staged in
  [statuses.json](statuses.json).
- The place a move names is its location. The date is a wall clock without a zone, dated on the
  zone of that place when the place is known.
- The container's size, type and class, and the vessel, are not read.

## Limitations

- A container lookup returns the container's last move, which may belong to a later shipment than
  the one asked about.
- Only containers are supported. The search also finds a vehicle by its VIN, and has no search for
  bookings or bills of lading.
- The website does not answer every network: from some, the request times out.

## Numbers

Containers are ISO 6346 numbers, whose check digit is checked before the lookup. Seaboard Marine's
own containers carry its `SMLU` owner code. Detection has no rule. The samples and their sources
are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/seaboard-marine`, with `SEABOARD_MARINE_TRACKING_NUMBER`
and `SEABOARD_MARINE_UNKNOWN_NUMBER` set outside the repository.
