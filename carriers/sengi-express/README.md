# Sengi Express

Sengi Express parcels use enabled universal providers. There is no dedicated adapter.

Sengi Express (Seng Yi (Shenzhen) Global Supply Chain Management) is a Chinese cross-border
forwarder controlled by Poste Italiane. It carries parcels from China to Italy and other European
countries, where Poste Italiane or the destination's post delivers them. Its site is
sengiexpress.com.

## Numbers

Parcels for Malta carry five letters, nine digits and `MT`. ParcelsApp names
[MaltaPost](../maltapost/README.md) beside Sengi for one and relays MaltaPost's scans, so the
rule is low confidence and shared with MaltaPost, the carrier recognition asks about it. Parcels
for Italy are tracked under Poste Italiane's codes, which its own rules cover. Sengi's tracker
answers those codes too, so when an aggregator names Sengi beside a code Poste's rule claims at
high confidence, the hint goes to Poste Italiane (`core/catalog/partners.ts`).

## Why there is no adapter

Its tracker at portal.sengiexpress.com posts the numbers to `api-v2/tracking/web` without a
session and answers an empty object for any number it does not hold. For a parcel to Italy it
gives only the line's channel and Cainiao's advance notice to the last mile, which
[AliExpress / Cainiao](../aliexpress/README.md) already gives as the earlier leg (see
[Poste Italiane](../poste-italiane/README.md)).

## Links

The tracker reads numbers from a form and opens no per-number page, so the catalog sends people
to it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
