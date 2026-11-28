# Spediamo

Spediamo shipments use enabled universal providers. There is no dedicated adapter.

Spediamo, run by Salesteam in Milan, is a shipping service for businesses and private senders. It books shipments with partner couriers, and its tracker finds a shipment by its own code or the courier's waybill.

## Numbers

Its help text shows its own code as a letter and three digits, then three hyphenated groups of three digits. No
public page shows one, so there is no rule.

## Why there is no adapter

The page asks `GET https://api.spediamo.it/v1/shipments/tracking?code=<code>`. With no public number to check the tracker's replies against, there is no adapter.

## Links

`spediamo.it/ext/tracking?code=<code>` opens one shipment; the page searches on load.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
