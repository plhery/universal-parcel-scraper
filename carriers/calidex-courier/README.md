# Calidex Courier

Select Calidex Courier and use its complete guide number. The adapter runs the Guía search of the [Calidex guest tracker](https://calidex.multitrack.trackingpremium.us/tracking/tracking). The carrier’s [tracking instructions](https://calidex.co/#rastreo) link this TrackingPremium tenant and publish `CAL1500794680` as an example. The adapter confirms the guide in the response header and uses the corresponding top-level movement table.

Calidex displays month-first local clocks. The adapter keeps them without assigning an offset to either side of the border. It retains the movement, date, and location and omits free-text comments, package details and images. `Disponible para retiro` marks pickup availability. The wording `Finalizado` closes the guide with no explicit delivery stage.

The guest tracker returned 18 movements for `CAL1500794680` and 11 movements for [published guide `CLO1500794271`](https://es.scribd.com/document/827357577/guide-186-CLO1500794271) on November 20, 2026.

```sh
CALIDEX_TRACKING_NUMBER=CAL1500794680 CALIDEX_UNKNOWN_NUMBER=XXX0000000000 npm run test:carriers:live -- carriers/calidex-courier
```
