# Pack Express Guatemala

Select Pack Express Guatemala and enter the guide number from the shipping
label. The adapter uses the same lookup as the
[carrier’s guest tracker](https://packexpress.com.gt/rastreo-de-envios/) and
checks the returned guide against the number supplied.

The public example has four dated movements. The adapter keeps the printed
local clocks and reads delivery from the route, where the tracker also shows
an administrative guide badge. The site also renders a device service history
through the same lookup. Receiving parties, device identifiers and live
vehicle coordinates are excluded.

Set `PACK_EXPRESS_GT_NUMBER` and run
`npm run test:carriers:live -- carriers/pack-express-gt` to verify the sample.
