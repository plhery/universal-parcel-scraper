# SendBox Argentina

Select SendBox Argentina and enter the complete guide printed with its four-digit Z and eight-digit serial. The adapter opens the carrier’s guest form and uses its current form state to submit both parts. [Official tracking form and example label](https://www.sendbox.com.ar/seguimiento/)

The response gives a shipment status and guide creation date. The example returned `Entregado` with the date printed on its label. An unknown guide returned the carrier’s empty-result code. The carrier responds to both guide components and omits them from the response body. The adapter reports the status and leaves the event history and delivery clock empty.

```sh
SENDBOX_ARGENTINA_TRACKING_NUMBER=Z-0117-00443416 SENDBOX_ARGENTINA_UNKNOWN_NUMBER=Z-0000-00000000 npm run test:carriers:live -- carriers/sendbox-argentina
```
