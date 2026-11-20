# Enviamos Comunicaciones

Select Enviamos Comunicaciones and enter the main code on the physical mailing label. The adapter uses the anonymous main-code search and verifies the exact guide in the shipment heading and details. [Official tracker](https://www.enviamoscym.com/rastreo-envios-mensajeria.php) · [Carrier service terms](https://enviamoscym.com/files/condiciones-generales-del-servicio-de-mensajeria-expresa-enviamos-comunicaciones.pdf)

The portal reports an office intake date, a last visit date and an outcome. The adapter keeps those dates at day precision. The published samples are physical certified mailings independently described as delivered in court orders. The adapter maps their exact affirmative certified outcome to delivered and keeps the last visit as a separate event without a delivery time. Other outcome text and personal details, proof links and certificates stay out of the result.

```sh
ENVIAMOS_COMUNICACIONES_TRACKING_NUMBER=… ENVIAMOS_COMUNICACIONES_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/enviamos-comunicaciones
```
