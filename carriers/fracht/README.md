# Fracht

Fracht shipments use enabled universal providers. There is no dedicated adapter.

Fracht, from Basel, forwards sea, air and road freight through its group's offices worldwide.

## Numbers

The tracker takes a shipment, order, house bill or reference number, so there is no rule.

## Why there is no adapter

The tracking page asks `/FunctionV2/JobSearch.php` for the shipment; signing in is optional. With no public number to check the tracker's replies against, there is no adapter.

## Links

`your.fracht.com/Track.php?SearchValue=<number>` searches on load, as the page's script reads that parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
