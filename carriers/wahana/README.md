# Wahana Express

The dedicated adapter reads Wahana's public guest tracker. Its eight-character resi is too
generic for an offline detection rule; choose Wahana explicitly or use an enabled provider's
carrier hint. A tracker link identifies the number but still needs guest verification.

The adapter opens a fresh HTTP session, reads Captcheck's five image choices and matches the
requested letter or digit with local OCR. It tries at most two generations. Keeping each
character's proportions matters; the model's ordinary wide text resize loses it. Ambiguous
or unreadable choices stay challenges, and enabled providers remain available. The accessible
text alternative does not pass the tracker's verification.

`sharp` and `onnxruntime-web` are optional peers needed for this lookup. The model and decoder
load in a bounded worker on first use, with cancellation and a short idle lifetime. No browser
service is needed.

The parser requires one matching shipment card and keeps the complete collapsed timeline.
It leaves scan clocks local because the page states no offset, removes recipient and courier
names from delivery wording, and drops contact fields. A capped history stays incomplete.
A verification refusal is separate from the portal's no-history reply.

The Sahabat Wahana app restricts tracking to shipments booked through its own account.
Agent and partner portals also require accounts; the adapter uses none of them.

Run the opt-in live test with `WAHANA_TEST_NUMBER`:

```sh
npm run test:carriers:live -- carriers/wahana
```
