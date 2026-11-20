# Transportes Chevalier

Select Transportes Chevalier and enter the guide printed below the barcode. The adapter queries the FivePostal tenant used by the carrier’s guest form and verifies the full guide in the shipment and every movement. [Official tracker](https://www.transporteschevalier.com/consulttag.html)

Movement clocks are local and carry no offset. The adapter keeps the carrier’s wording and branch city, omits prefacture and guide-digitization entries, and collapses duplicate records with the same time, status and branch. It leaves the dispatch manifest entry unmapped and uses the delivery scan for current status. It omits personal fields and proof-of-delivery attachments.

```sh
TRANSPORTES_CHEVALIER_TRACKING_NUMBER=… TRANSPORTES_CHEVALIER_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/transportes-chevalier
```
