# DYPAQ

DYPAQ is a Mexican courier based in Mérida. It collects parcels from businesses and delivers them
across the south and southeast of Mexico through its own offices and routes. Tracked through the
service behind the tracking form on its home page.

## How it works

1. `direct`: `POST https://www.dypaq.com/wp-json/dypaq_services/v1/tracking` with the JSON body
   `{"guia": "<number>"}`. No account, key, session or browser is needed.
2. `retry`: when DYPAQ cannot be reached or hangs, the service is asked again once. The first try
   gets half of the budget.

- The reply holds a delivery block, which names the guía and, once delivered, who took it, and
  the movements newest first, each naming the guía. Only movements naming the whole guía asked
  are read.
- A guía DYPAQ does not hold gets the block naming it and no movements; that is not found. No
  movements under a block naming something else is a changed reply.
- A 404 or a 410 means the service moved; a 403 or a bot check is a challenge.
- Recognition makes the same request.

## Notes

- Movement clocks carry no zone and stay local times. Offices stretch across Mexico's zones,
  Quintana Roo's among them, and nothing says whether a clock is the office's or the system's.
  The office becomes the event's location.
- Some movements carry a link to a map of the collection point after their wording; it is not
  read.
- Line hauls and delivery routes are named after a fixed start, "Embarcado a circuito" and
  "Embarque a ruta"; the map reads the start.
- The recipient's name, address and postcode, who signed, the signature image, its coordinates,
  the pieces delivered and the comments under movements are not kept.

## Limitations

- No instant for any movement, so no delivery time; no estimate, weight, service or sender.

## Numbers

The guías in DYPAQ's API documentation are two letters and nine digits. No rule claims that
layout until more guías confirm it, so recognition never asks DYPAQ and a lookup reaches it
when the carrier is chosen. The adapter takes eight to twenty capitals and digits.

## Links

The tracking form sits on the home page and has no address that opens one guía, so no link is
read.

## Testing

`npm run test:carriers:live -- carriers/dypaq`, with `DYPAQ_TRACKING_NUMBER` and optionally
`DYPAQ_UNKNOWN_NUMBER` set outside the repository.
