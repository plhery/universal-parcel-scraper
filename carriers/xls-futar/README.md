# XLS Futár

The adapter reads the carrier's public, number-only parcel summary. It is used when XLS
Futár is selected; the numeric input does not establish carrier ownership.

The [guest tracker](https://xlsfutar.hu/track) returns HTML identifying the input in its
tracking form, one active state and a last-change day. A single whole-reference request
must return that matching form and the native result layout. Only the tracker's explicit
missing-parcel notice means not found; unfinished pages and browser checks stay distinct.
No PIN is submitted.

The result is marked `summary_only`, so enabled providers can supply fuller history.
The last-change day stays date-only; it is not a delivery scan or an invented midnight.
The adapter omits postcodes and does not infer delivery from the ambiguous closed state.

Run live retrieval with `XLS_FUTAR_TEST_NUMBER` set outside Git:

```sh
npm run test:live -- carriers/xls-futar/adapter.live.test.ts
```
