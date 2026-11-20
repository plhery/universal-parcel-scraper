# MANDDE

Select MANDDE and enter the guide printed on the parcel label. The adapter submits the guide to the carrier's anonymous tracking API for MANDDE SAS, company 1 in the public carrier list. It checks the full guide echoed on each movement. [Official tracker](https://www.mandde.com.co/rastreo.html)

The carrier's front end reads SQL timestamps as wall clocks even when the serialized value ends in `Z`. The adapter preserves those clocks locally. It maps the six observed movement codes from registration to delivery and keeps city-level scan locations. It omits incident notes, reference identifiers, signatures and images. The public tracker opens a search form and deliberately clears query parameters.

The Alquimia client manual's indexed example in section 3.3 returned six movements from Bogotá to Pereira, ending in delivery. The sample source URL now returns HTTP 404 directly. [Indexed official manual](https://mandde.com.co/puntosges/Manual_ALQUIMIA_CLIENTES_2025_Gui%CC%81a_Sticker.pdf)

```sh
MANDDE_TRACKING_NUMBER=4000030219752 MANDDE_UNKNOWN_NUMBER=00000000000000000000 npm run test:carriers:live -- carriers/mandde
```
