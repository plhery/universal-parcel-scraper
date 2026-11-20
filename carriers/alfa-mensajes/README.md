# Alfa Mensajes

Select Alfa Mensajes and enter the complete physical `NF` guide. The adapter reads the carrier’s [public guide lookup](https://alfamensajes.com/) through its Dimail guest service. It confirms the full guide and the physical shipment type.

The adapter keeps named status and assignment movements with the UTC times printed by the carrier. It derives the delivery time from a dated `entregado` movement. The lookup payload also carries administrative logs, address and contact details, and document references. Those fields stay out of the result and fixtures.

```sh
ALFA_MENSAJES_TRACKING_NUMBER=… ALFA_MENSAJES_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/alfa-mensajes
```
