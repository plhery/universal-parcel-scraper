# Emile

Canadian last-mile courier for parcels that consolidators such as 4PX, Yanwen and YunExpress
bring in from China. A number filed under Emile is tracked through the
[universal providers](../../providers/README.md) the consumer enables; provider evidence
belongs in [COVERAGE.md](../../providers/COVERAGE.md). The tracking page link stays
available.

## Retrieval

There is no direct adapter. Emile's tracking page sends each lookup to its tracking API with
a Cloudflare Turnstile token, so a lookup needs a visitor's browser to pass that check first.
Solving or leaving out the check is out of scope, as for
[Asendia](../asendia/README.md#rejected-approaches). The site's other leads give no way
around it:

- The API host behind the site asks for a merchant sign-in.
- The merchant portal some aggregators link to no longer resolves.
- The support chat asks for a name, email and phone number and opens a conversation with
  Emile's staff; it is not a lookup.
- Emile publishes staff and driver apps only.
- The tracking page of the earlier site is gone.

ParcelsApp returns the history the consolidator relays, Emile's scans included. Universal
providers remain opt-in; detecting the number does not enable one.

## Notes

- Numbers are `EM`, twelve digits and `CA`. The support chat on Emile's site asks for a
  tracking number that starts with `EM` and ends with `CA`, and consolidators' feeds and
  tracking aggregators use the shape for Emile, so detection suggests Emile. It never selects
  it: nothing in the number can be checked. A number the consumer files under Emile goes to
  the providers as Emile's; one left unknown goes to them too.
- Canada Post's EMS items share the prefix and the suffix but carry nine digits, the
  international postal layout, and stay Canada Post's.
- A consolidator's adapter whose feed names Emile as the last-mile carrier reports Emile and
  its number as the delivery carrier and number. That proposes no hand-off lookup: the feed
  already relays Emile's scans, and a provider lookup of Emile's number would return the same
  relay.
- A pasted `emileps.com` tracking link names the carrier and carries the number.
- Scans ParcelsApp files under Emile's name take their stage from the status texts in
  `statuses.json`, in any case, as Emile's page reads them, and keep the wording relayed. A
  text with no stage there, such as a fee, leaves the parcel at the stage it had. ParcelsApp
  files most of Emile's scans under the consolidator's name instead, a name that also carries
  the consolidator's own scans, so those go through the shared wording rules.

## Limitations

The catalog supplies no assumed scan timezone, because Emile delivers across several Canadian
zones. ParcelsApp gives Emile's local clocks as UTC, so Emile's scans come out hours early, and
nothing it relays settles their zone: it files most of them under the consolidator's name,
whose other scans keep other clocks, its copies under Emile's name give only the country, and
only the delivery names a province. Delivered scans relayed by the providers can carry the
recipient's postcode. Emile's page shows a delivery photo behind the recipient's postal code;
no provider relays it.

## Testing

`npm run test:carriers:live -- carriers/emile` needs `EMILE_TRACKING_NUMBER` and checks
retrieval through ParcelsApp. Offline tests use synthetic history.
