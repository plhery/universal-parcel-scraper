# D’Jesu COMER

The [public shipment tracker](https://www.jesucomer.com/rastreo-envio/) takes the
guide number issued for a parcel. Select D’Jesu COMER and enter the guide from
the shipping confirmation. The site calls that reference an order number.

The result echoes the guide and marks its current step. The adapter keeps the
completed milestones and uses the creation date for the registration event.
Later milestones carry their status wording and no timestamps.

Run the live test with `D_JESU_COMER_NUMBER` set and
`npm run test:carriers:live -- carriers/d-jesu-comer`.
