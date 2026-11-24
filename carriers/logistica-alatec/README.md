# Logística Alatec

Logística Alatec parcels use enabled universal providers. There is no dedicated adapter.

Logística Alatec is a courier in A Coruña for local and national parcels, delivered with its own
vehicles and through the [GLS](../gls-es/README.md) and [CTT Express](../ctt-express/README.md)
networks.

## Numbers

No public page shows a Logística Alatec number, so there is no rule.

## Why there is no adapter

The tracker is the company's tenant of the IRIS courier software on `logisticaalatec.factapp.es`. No
public number is known to check its replies against.

## Links

The company's site links the tracker. `/IRIS/Seguimiento?s=<number>` opens one shipment, so the
catalog links each number there. Each IRIS tenant keeps its own shipments, so links are read only on
the company's tenant.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
