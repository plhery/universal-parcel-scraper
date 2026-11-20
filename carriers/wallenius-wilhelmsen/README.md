# Wallenius Wilhelmsen

Select Wallenius Wilhelmsen and enter the bill of lading. The adapter accepts bills with the `WLWH` manifest prefix and passes the bill itself to the carrier’s public BOL form. The guest service requires the session from a local Chromium browser. Set `TRACKING_CHROMIUM_PATH` to its executable. [Official tracker](https://www.walleniuswilhelmsen.com/track-trace)

The adapter checks the bill echoed by the carrier. It keeps actual status clocks and port movements. It omits estimated arrival and vehicle identifiers. Discharge records removal from the vessel. A bill with several cargo rows reports their common status if they agree and returns their latest recorded movements. The carrier can answer an unknown bill with HTTP 500, which the adapter treats as a transport failure.

```sh
TRACKING_CHROMIUM_PATH=… WALLENIUS_WILHELMSEN_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/wallenius-wilhelmsen
```
