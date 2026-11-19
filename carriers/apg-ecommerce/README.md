# APG eCommerce Solutions

The adapter reads the server-rendered history on APG's
[public tracker](https://apgecommerce.com/track/). The tracker needs no session or secondary
input. The result must repeat the whole fourteen-digit APG reference in the tracking-number
heading. Merchant order references and partner barcodes stay with provider fallback.

The history table labels its clock GMT and gives the country separately. The adapter keeps the
explicit GMT time, the country code and the canonical event description. It omits the
merchant reference and detailed event text. A scan whose description holds a digit, markup,
a link or a signer is left out, and the history is then marked incomplete so enabled
providers can fill it; a place that is not a country code is left out of its scan. An
attempt or return in progress can precede a later delivery.

An exact missing-order reply must repeat the requested reference. Unavailable pages and
verification refusals keep their own failure kinds. A network failure can be retried within
the lookup budget.

Supply `APG_ECOMMERCE_TRACKING_NUMBER` and optionally `APG_ECOMMERCE_UNKNOWN_NUMBER` outside
the repository and run:

```sh
npm run test:carriers:live -- carriers/apg-ecommerce/adapter.live.test.ts
```
