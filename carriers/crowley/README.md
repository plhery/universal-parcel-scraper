# Crowley

Select Crowley and enter a bill of lading from its full-container tracking service. The adapter accepts the original bill or a Crowley manifest bill beginning with the `CLAM` or `CWLQ` SCAC immediately before `CW`. [Official tracker](https://csight.crowley.com/crowley/s/shipment-tracking)

The adapter submits one bill at a time through Crowley’s public guest service. The service returns equipment and movement histories without echoing the bill. The public samples were checked against the equipment numbers printed in their manifests. The adapter reads up to 100 movements, keeps the carrier’s local timestamps and combines duplicate movements. Loading, discharge and gate activity show progress through the network. Detaching or stripping equipment does not establish delivery.

```sh
CROWLEY_TRACKING_NUMBER=CLAMCWPN26201624 CROWLEY_UNKNOWN_NUMBER=ZZZZ00000000 npm run test:carriers:live -- carriers/crowley
CROWLEY_TRACKING_NUMBER=CWLQCWPS26270874 CROWLEY_PAGINATED_NUMBER=CLAMCWPN26172288 npm run test:carriers:live -- carriers/crowley
```
