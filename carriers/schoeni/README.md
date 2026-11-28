# Schöni Transport

Schöni Transport shipments use enabled universal providers. There is no dedicated adapter.

Schöni Transport, from Rothrist, carries road freight in Switzerland and abroad and delivers online shops' goods.

## Numbers

The tracker takes an ID number. No public page shows one, so there is no rule.

## Why there is no adapter

The tracker is a public web application that asks `/v1/tracktrace/<number>` of Schöni's API. With no public number to check the tracker's replies against, there is no adapter.

## Links

`my.schoeni.ch/public/de-ch/track-and-trace/<number>` opens one shipment; the application keeps the number in its
path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
