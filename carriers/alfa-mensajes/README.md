# Alfa Mensajes

Select Alfa Mensajes and enter the complete physical `NF` guide. The adapter reads the carrier’s [public guide lookup](https://alfamensajes.com/) through its Dimail guest service. It confirms the full guide and the physical shipment type.

The adapter keeps named status and assignment movements with the UTC times printed by the carrier. It derives the delivery time from a dated `entregado` movement. The lookup payload also carries administrative logs, address and contact details, and document references. Those fields stay out of the result and fixtures.

A [public judicial publication](https://publicacionesprocesales.ramajudicial.gov.co/c/document_library/get_file?groupId=6098902&uuid=d0ecfce4-1f56-e925-fad9-ec956263a81a) names physical guide `NF202612583`. The guest service confirmed the guide and returned four named movements on November 20, 2026.

```sh
ALFA_MENSAJES_TRACKING_NUMBER=NF202612583 ALFA_MENSAJES_UNKNOWN_NUMBER=NF000000000 npm run test:carriers:live -- carriers/alfa-mensajes
```
