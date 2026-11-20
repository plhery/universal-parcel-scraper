# Transportes Chevalier

Select Transportes Chevalier and enter the guide printed below the barcode. The adapter queries the FivePostal tenant used by the carrier’s guest form and verifies the full guide in the shipment and every movement. [Official tracker](https://www.transporteschevalier.com/consulttag.html)

Movement clocks are local and carry no offset. The adapter keeps the carrier’s wording and branch city, omits prefacture and guide-digitization entries, and collapses duplicate records with the same time, status and branch. It leaves the dispatch manifest entry unmapped and uses the delivery scan for current status. It omits personal fields and proof-of-delivery attachments.

The native response for the guide on the public March 2025 freight invoice yields seven shipment events and a delivery in Maicao. [Published freight invoice](https://es.scribd.com/document/846275950/Tercero-Equivocado-Tania-Rojas)

```sh
TRANSPORTES_CHEVALIER_TRACKING_NUMBER=7749120505 TRANSPORTES_CHEVALIER_UNKNOWN_NUMBER=0000000000 npm run test:carriers:live -- carriers/transportes-chevalier
```
