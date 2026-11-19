# South Post

South Post S.A. is an Argentine postal operator licensed by ENACOM. It distributes parcels and
mail nationwide from branches in Buenos Aires, Córdoba, Tucumán, Mendoza and other provinces,
and prepares orders from shops' stock. Its site is southpost.com.ar.

## Numbers

Its tracking numbers are digits only, at most seven, as its form allows. Short digit runs are
other carriers' numbers too, so there is no rule; the adapter answers an explicit selection.

## Retrieval

The site is a script app. `/#/t/<number>` runs the lookup on load, posting `{"nro_guia": …}` as
JSON to `tracker.southpost.com.ar/seguimiento` without a session or a key. The adapter sends the
same request and requires the reply's `nro_guia` and every scan's `guia` to be the number asked.

The tracker answered an unknown number with HTTP 500 and `{"error":"Error servidor Epresi"}`,
the way it would answer a failure of its own, and the page shows "not found" for any error. The
adapter cannot tell them apart, so that answer stays an inconclusive failure, never not found.
An HTTP 404 means the service moved.

The reply lists the scans newest first, each with a `fecha` and `hora` on Argentina's
UTC−03:00 and a `receptor_fecha_hora` that repeats the minute with its seconds; the adapter
reads the seconds when the two agree. A delivered shipment gets further `ENTREGADA` rows as its
proof goes back to the sender, so the delivery is dated by the first of the newest run of them,
and the receiver is the `receptor` the page shows, else the `receptor_nombre` of those rows.
The details beside a status are left out.

## Stages

The page's script reads each `estado` in lower case and groups the wordings into its rail:
preparing the order, ready to deliver, on the way, delivered. The map follows those steps and
stages the problems the page explains: missed visits, a parcel held for collection, delivery
problems, a cancelled order and returns. A visit put off for technical problems keeps the stage
before it. The page's exchange and recovery wordings, the collection of a product to go back to
the shop and its request to contact customer care stay without a stage. A wording the map does
not list goes to the shared wording rules.

## Testing

`SOUTH_POST_TRACKING_NUMBER=… SOUTH_POST_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/south-post`
