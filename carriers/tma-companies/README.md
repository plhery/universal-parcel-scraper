# TMA

TMA parcels use enabled universal providers. There is no dedicated adapter.

TMA, or TMA Companies, is a freight carrier and broker in Penryn, California, with terminals in
Northern and Southern California. It runs less-than-truckload, flatbed and expedited freight with
its own trucks. Its site is tmacompanies.com.

## Numbers

Its tracker's example is a nine-digit PRO number, and an aggregator's example is T and eight
digits. Nine-character numbers fit many carriers, so there is no rule.

## Why there is no adapter

Its single-shipment tracker is an ASP.NET form that posts the PRO or pickup number with the
destination ZIP code, or a purchase order number, as a check. Tracking several shipments needs a
login.

## Links

The tracker takes the number with a ZIP code or purchase order number in a posted form, so no
address opens one shipment. An older `tracking/tracking2.aspx` address with a `proNumber`
parameter does not answer.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
