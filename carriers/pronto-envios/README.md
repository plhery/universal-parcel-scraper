# Pronto Envíos

Select Pronto Envíos and enter the numeric guide for Colombia’s Pronto Envíos Logística. The official form opens its carrier-specific FivePostal page. [Official tracker](https://www.prontoenvios.com.co/consulta_fivepostal.php)

The adapter uses the public shipment reply and checks the guide number in the shipment and in each scan. It retains the carrier’s Bogotá local clocks and city names. Notices, digital copies, manifest paperwork, signatures, addresses and contact information stay out of the movement history. A digitized return record indicates an unsuccessful delivery. An explicit delivery scan establishes delivery even if the tracker subsequently logs certification or a digital copy.

```sh
PRONTO_ENVIOS_TRACKING_NUMBER=666174400825 PRONTO_ENVIOS_MISSING_NUMBER=625876700935 npm run test:carriers:live -- carriers/pronto-envios
PRONTO_ENVIOS_TRACKING_NUMBER=603973900825 npm run test:carriers:live -- carriers/pronto-envios
PRONTO_ENVIOS_TRACKING_NUMBER=659204500865 npm run test:carriers:live -- carriers/pronto-envios
```
