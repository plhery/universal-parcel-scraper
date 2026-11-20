# Volaris Cargo

Volaris Cargo operates Mexican air freight. Select Volaris Cargo explicitly and enter the eight-digit serial or the complete air waybill beginning with `036`.

The [SmartKargo tracking page](https://volarisy4.smartkargo.com/FrmAWBTracking.aspx) accepts the prefix and serial separately. The adapter verifies the full air waybill shown in the result header, then reads the activity summary and movement table. The tracker shows local clocks without offsets. The adapter preserves them as reported, along with the three-letter airport codes, and omits flight details, equipment identifiers and delivery-order links.

The [published Baja California procurement waybill](https://wsextbc.ebajacalifornia.gob.mx/CdnBc/api/Imagenes/ObtenerImagenDeSistema?descargar=false&nombreArchivo=FuenteOrigen%2F59%2F2720210803114705.pdf&sistemaSolicitante=setBC%2F) documents the shipment used in the fixture. The airline also documents an `A02` prefix in its older cargo FAQ. This adapter covers the independently verified `036` service.

```sh
VOLARIS_CARGO_TRACKING_NUMBER=036-18709025 npx vitest run --config vitest.carriers-live.config.ts carriers/volaris-cargo/adapter.live.test.ts --maxWorkers 1
```
