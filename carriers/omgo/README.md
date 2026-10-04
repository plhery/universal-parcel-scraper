# OMGO

OMGO Express cross-border shipments are detected locally and tracked through the
[universal providers](../../providers/README.md) the consumer enables. Provider
evidence belongs in [COVERAGE.md](../../providers/COVERAGE.md).

## Retrieval

The public form at [omgoexpress.cn](https://omgoexpress.cn/) returns a form
confirmation without tracking history. The older tracker on port 8082 is
unreachable, so there is no independent direct adapter. Universal providers
remain opt-in; detecting OMGO does not enable one.

## Limitations

Detection covers the observed shipment-number shape, not every reference OMGO
may issue. The catalog supplies no assumed scan timezone: providers retain their
own clock evidence. A delivery partner remains separate from the OMGO number.

## Testing

`npm run test:carriers:live -- carriers/omgo` needs `OMGO_TRACKING_NUMBER` and
checks retrieval through ParcelsApp. Offline tests use synthetic history.
