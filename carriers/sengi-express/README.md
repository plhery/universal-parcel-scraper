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

Other parcels for Italy carry an SDA waybill: three digits, `C`, eight digits and `F`. Until SDA
takes the parcel only Sengi's tracker knows it, and universal providers relay its rows under
Sengi's name. Detection suggests Poste Italiane and AliExpress for the shape and leaves Sengi out:
the waybill is SDA's, AliExpress shows its buyers SDA waybills too, Sengi publishes no format of
its own, and without an adapter recognition cannot ask its tracker.

## Tracker

Its tracker at portal.sengiexpress.com posts the numbers to `api-v2/tracking/web` without a
session, cookie or CAPTCHA and answers an object keyed by each number it holds, or an empty
object. It holds Sengi's own consignments only. For a parcel with a Poste code it gives only the
line's channel and Cainiao's advance notice to the last mile, which
[AliExpress / Cainiao](../aliexpress/README.md) already gives as the earlier leg (see
[Poste Italiane](../poste-italiane/README.md)). For a parcel with an SDA waybill it gives the leg
before SDA: the order data, the arrival airport, import clearance and the handover to the last
mile, each row with an event code and a wall clock with its UTC offset in hours. That is the
lead for an adapter, with recognition for the SDA shape.

## Links

The tracker reads numbers from a form and opens no per-number page, so the catalog sends people
to it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
