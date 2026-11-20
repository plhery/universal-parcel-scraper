# Maersk

Maersk, A.P. Moller - Maersk, is the Danish container line. Tracked through its public tracking
page for a bill of lading, a booking or a container. Its parcel business is
[Maersk eCommerce](../maersk-ecommerce/README.md) and its freight network
[Pilot Freight Services](../pilot-freight/README.md).

## How it works

`browser`: with `TRACKING_CHROMIUM_PATH`, a fresh context opens
`https://www.maersk.com/tracking/{number}`. The page asks
`GET https://api.maersk.com/synergy/tracking/{number}?operator=MAEU` itself, and the adapter reads
that reply: each container of the shipment and the moves at each of its places.

Akamai answers a request without the sensor data the page's script sends with a 403, so plain
HTTP cannot make the lookup; a browser passes. No account, cookie or CAPTCHA is needed.

## Notes

- Only the main frame's GET of the lookup URL for the whole number is read. A bill's reply must
  name the bill, and each container must belong to it; a container lookup reads that container
  alone.
- A number Maersk does not hold is a 404 whose JSON names the number and the lookup, read as not
  found. Any other 404, Akamai's 403 and a redirect away from the page are not.
- Each move keeps its place's wall clock. Where the place's country keeps one zone, or a US
  state's code names one, the move also gets its instant; Brazil's ports keep the wall clock
  alone. Puerto Rico's zone comes from its name, since its code is also a state's.
- An event's code is the page's label for it: a gate move of an empty container and the gate
  out for delivery are labels of their own. They are staged in [statuses.json](statuses.json).
  The empty container's return after the consignee unloaded it is the delivery, and a gate in
  after the container moved, at a port it reached by rail or truck, is transit.
- A bill's containers move apart. The bill is delivered once every container is returned;
  until then the latest open stage leads. Moves the containers share are kept once.
- Moves Maersk still expects are planned steps. Rows the page leaves out, such as the trucker's
  pickup and drop, are not read; neither are vessels, voyages, sizes or the parties.

## Limitations

- When Akamai refuses the page or its lookup, the result is a challenge.
- A shipment listed without moves, a cancelled one too, is no history.

## Numbers

Bills of lading and bookings are nine characters, digits or letters with at least one digit;
import records put `MAEU`, Maersk's carrier code, before them, and the adapter drops it.
Containers are ISO 6346 numbers, whose check digit is checked before the lookup. Detection has
no rule. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/maersk`, with `MAERSK_TRACKING_NUMBER`,
`MAERSK_UNKNOWN_NUMBER` and `TRACKING_CHROMIUM_PATH` set outside the repository.
