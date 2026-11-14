# Globex Post

Globex Post parcels use enabled universal providers. There is no dedicated adapter.

Globex Post, ТОВ «Глобекс Пост» of Stryi, is a Ukrainian carrier of parcels, documents and mail
from the United States and Europe into Ukraine: it clears them through customs and delivers them to
the recipient.

## Numbers

Its tracking form takes the parcel's tracking number. No public page shows a whole number or its
layout, so there is no rule.

## Why there is no adapter

The home page's tracking form asks the site for the parcel's events and shows them with their
time, and a payment link when customs duties are due. With no public number to check its replies
against, there is no adapter.

## Leads

`https://globexpost.com/tracking/{number}/` answers a GET with JSON: the parcel's events, each with
a `timestamp` and an `action`, and `customs_payment_url` when duties are due.

## Links

Its tracker takes numbers only through its form, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
