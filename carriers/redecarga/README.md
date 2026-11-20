# Redecarga

Redecarga transports packages and freight within Colombia. The [carrier's public Gelotra tracker](https://redecarga.gelotra.com/rastrearguia)
accepts the guide printed on the shipment receipt.

The adapter calls the tracker's `GET /rastrearguia?guia=…` route and reads its server-rendered
timeline. It checks the guide echoed by the search form and any guide printed in the document
links. Status descriptions come from the visible event headings. The adapter retains the
precision of the reported wall clocks, including both the minute and second formats on the
same timeline. The document links and supplementary details are outside this adapter.

The [Colombia Compra Eficiente procurement record](https://operaciones.colombiacompra.gov.co/sites/cce_public/files/documentos_adicionales_oc/cuenta_no.1_6.pdf)
publishes two guides. They returned nine and two dated events. Select Redecarga explicitly.

Set `REDECARGA_TRACKING_NUMBER` and run `npm run test:carriers:live -- carriers/redecarga`.
