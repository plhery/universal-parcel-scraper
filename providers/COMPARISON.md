# Choosing a provider

[coverage.json](coverage.json) records the evidence and [COVERAGE.md](COVERAGE.md) renders it.
This page says how that evidence becomes an order.

`universalPlan()` takes the eligible providers for a carrier and sorts them by that carrier's
history tier, fuller history first. A source that was inconclusive or empty stays eligible.
One that answered with the wrong carrier or refused the format is left out, as long as
another usable source remains. Extra references inform the tiers without changing the
comparison table.

Providers in one tier have equally full history, so the choice between them is about speed
and load. Speed comes first when someone may be waiting: plain HTTP answers within a second
and a browser read takes several, so the HTTP providers are asked first. A lookup in the
background (`background: true`) has no one waiting and skips that.

Load decides the rest. One provider asked about every number is the provider most likely to
refuse the lookups, and the one whose refusal would cost the most. So the providers of a tier
share the numbers by weighted rendezvous hashing: each provider draws a value from the number
and its own name, and the lowest draw is asked first. A number keeps its order at every
lookup, which lets a consumer keep a parcel with the provider that answered. A provider leads
a part of the numbers in proportion to its `share`, and when one is left out or rests, the
others take its numbers in the same proportion without changing their own order.

The shares say which providers to spare. ParcelsApp and 17TRACK are each the only source of
several carriers ([COVERAGE.md](COVERAGE.md) counts them), so losing either would leave
those carriers without history: they get the smaller shares, and 17TRACK the smallest, since
each of its lookups also costs a browser read. Ship24 is fast and no carrier depends on it
alone, so it takes the largest. Track123 could be lost as easily, but each of its lookups holds
a browser longer than any other provider's, so its share is 17TRACK's.

References are few, and one old number can misgrade a provider in either direction. A
consumer that follows many parcels knows more, and passes what it counted as `observed`: per
provider, the carrier's parcels it returned history for and those it missed while another
source had them. A lookup no source answered is not counted, since it says nothing about any
of them. From ten parcels on, the count replaces the references' tier: history for four
parcels in five is full, for one in five partial, for fewer empty, and for none excluded.
Two things a count cannot see stay as the references say. A provider they exclude stays out,
because another carrier's parcel would count as history. History they mark partial stays
partial, because a count sees parcels and not rows.

Three rules sit on top. Validated China Post C/L postal numbers go to 17TRACK first. Postal
Ninja, when enabled, comes after the other aggregators and never ranks above them, because
many of its histories have no scan a consumer can place; for a named carrier it is asked only
when that carrier's evidence shows its history. UPU needs a valid S10 number and stays
last, because its exchange-office history is sparse.

A provider is called at most once per lookup, with a bounded budget. The aggregators run only
when the consumer selects them, and the facade's default is UPU alone.

[universalPlan](plan.ts) is safe for browsers. Protocol implementations live in each provider
folder. The facade applies the selected provider set, and consumers with their own router can
use the same order with the Node primitives. Persistence, affinity, retries between lookups
and shared cooldowns belong to the consumer.
