# EPEX Colombia

Select EPEX Colombia and enter the numeric guide issued by Expreso Palmira Encomiendas. Its public form posts the guide to the carrier’s WordPress tracking endpoint. The adapter verifies the returned expedition number and recognizes a guide-specific missing response sent with HTTP 200. [Official tracker](https://epex.com.co/rastrea/)

The guest result gives dated statuses in Colombian wall time without a stated offset. The adapter keeps both scans when different statuses share the same timestamp. It leaves `Pendiente En Agencia` unmapped because the status alone does not confirm collection. It omits addresses, contact and courier details, incident notes, coordinates and delivery images.

The guide published in EPEX’s Acta 006 returned five actual events ending in `Incidencia`. [Carrier’s published shipment report](https://epex.com.co/wp-content/uploads/2022/04/Rezago_Acta_N006.pdf)

```sh
EPEX_COLOMBIA_TRACKING_NUMBER=130199640001 EPEX_COLOMBIA_UNKNOWN_NUMBER=000000000000 npm run test:carriers:live -- carriers/epex-colombia
```
