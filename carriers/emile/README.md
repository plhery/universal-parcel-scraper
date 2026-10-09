# Emile

Canadian last-mile courier for parcels that consolidators such as 4PX, Yanwen and YunExpress
bring in from China. Link only: the app recognizes the number and opens Emile's tracking page
with the number filled in.

## Why there is no automatic tracking

The tracking page sends each lookup with a Cloudflare Turnstile token, so a lookup needs a
visitor's browser to pass that check first.

## Notes

- Numbers are `EM`, twelve digits and `CA`. The support chat on Emile's site asks for a
  tracking number that starts with `EM` and ends with `CA`, and consolidators' feeds and
  tracking aggregators use the shape for Emile, so detection suggests Emile. It never selects
  it: nothing in the number can be checked.
- Canada Post's EMS items share the prefix and the suffix but carry nine digits, the
  international postal layout, and stay Canada Post's.
- The consolidator's feed relays Emile's scans. A consolidator's adapter whose feed names
  Emile as the last-mile carrier reports Emile as the delivery carrier.
- A pasted `emileps.com` tracking link names the carrier and carries the number.
