# ODM Express

ODM Express is a Mexican courier that carries parcels and freight to more than 250 destinations
in Mexico, in 24 to 72 hours or the same day, using the luggage holds of Omnibus de México's buses,
and sends shipments abroad. Its site is odmexpress.com.mx.

## Retrieval

One GET of the result page `/rastreo-2/?rastreo_fall=<guide>`, which draws the answer on the
server without a session. It lists the guide's rows oldest first: the day, the clock of the
branch that scanned it and an observation. Every row repeats the guide, which must be the one
asked; an unknown guide gets a notice that names it.

The clocks carry no zone and ODM's branches run on several of Mexico's, so each scan keeps its
wall clock. A row received at a distribution centre names it, which becomes the scan's place.
The observations also name the bus or route a guide went on, the employee who documented it,
the courier on the round and whoever took the delivery; the adapter keeps the bus and drops the
references and the people. A delivered guide links the scanned receipt, which is not read.

## Numbers

A guide is a letter and its serial. The page's examples have seven digits, the scanned receipt
pads the serial to nine, and the tracker answers either form. Many carriers print a letter and
a few digits, so there is no detection rule: select ODM Express or open its tracking link.

## Testing

`ODM_EXPRESS_TRACKING_NUMBER=… ODM_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/odm-express`
