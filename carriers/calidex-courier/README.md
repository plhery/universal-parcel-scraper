# Calidex Courier

Select Calidex Courier and use its complete guide number. The adapter runs the Guía search of the [Calidex guest tracker](https://calidex.multitrack.trackingpremium.us/tracking/tracking). The carrier’s [tracking instructions](https://calidex.co/#rastreo) link this TrackingPremium tenant. The adapter confirms the guide in the response header and uses the corresponding top-level movement table.

Calidex displays month-first local clocks. The adapter keeps them without assigning an offset to either side of the border. It retains the movement, date, and location and omits free-text comments, package details and images. `Disponible para retiro` marks pickup availability. The wording `Finalizado` closes the guide with no explicit delivery stage.

```sh
CALIDEX_COURIER_TRACKING_NUMBER=… CALIDEX_COURIER_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/calidex-courier
```
