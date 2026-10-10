# OMGO

OMGO Express cross-border shipments are detected locally and tracked through the
[universal providers](../../providers/README.md) the consumer enables. Provider
evidence belongs in [COVERAGE.md](../../providers/COVERAGE.md).

## Retrieval

The public form at [omgoexpress.cn](https://omgoexpress.cn/) posts to
[`/track-package/`](https://omgoexpress.cn/track-package/). That page's client
then posts `action=shi_get_tracking_info`, the page-issued nonce and
`tracking_codes` to `/wp-admin/admin-ajax.php`. The form submission alone is
not the tracking read; the nonce belongs to the current page and is not pinned.

The client projects `tracking_data` containing a tracking number, destination,
shipping method and `trackHistory`. Its generic "Tracking Code not Found"
error does not identify the requested parcel. Identity-bound positive history
through this route remains required before adding a direct adapter. The older
tracker on port 8082 is unreachable. Universal providers remain opt-in;
detecting OMGO does not enable one.

## Limitations

Detection covers the observed shipment-number shape, not every reference OMGO
may issue. The catalog supplies no assumed scan timezone: providers retain their
own clock evidence. A delivery partner remains separate from the OMGO number.

## Testing

`npm run test:carriers:live -- carriers/omgo` needs `OMGO_TRACKING_NUMBER` and
checks retrieval through ParcelsApp. Offline tests use synthetic history.
