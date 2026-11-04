# Flickpost

The adapter reads Flickpost's server-rendered guest tracking page through plain HTTP. It binds
the whole reference in the visible heading and copy field, and requires Flickpost booking or
hub activity alongside its service details before accepting partner history as its forwarding
service. A postal identifier alone establishes no Flickpost ownership.

## Numbers and routing

The lookup supports Flickpost's X references and valid Malaysian postal references. Bare postal
numbers keep Pos Malaysia detection; the short X format has no detection rule. Explicit carrier
selection and [Flickpost tracking links](https://flickpost.com/how-to-track-shipment-status/) reach
the native adapter. It adds no general postal recognition candidate. A named handoff can ask it
about a supported reference, subject to direct confirmation.

## Retrieval

`flickpost.com/tracking/` takes one `trackingNumber`. The page's hidden example and generic
invalid-number notice are separate from its actual result. Only the complete number-bound error
in the result block becomes not-found. Challenges, changed markup and unbound errors keep their
failure kinds; enabled universal providers remain available.

The timeline's order is retained because Malaysian and overseas wall clocks have no stated
offsets. A shipping label remains registration even under the broad Transit heading; customs
details distinguish clearance from linehaul. A Track and Trace link is an administrative entry.
The adapter retains service, weight, logistics activities and facilities, while omitting contact
footers, arbitrary comments, linked references and the page's application/onboarding forms.
Those unrelated forms contain CAPTCHA widgets; the tracking form does not require them.

## Testing

`FLICKPOST_TRACKING_NUMBER` and `FLICKPOST_OWN_NUMBER` supply retained postal and own-reference
histories; `FLICKPOST_UNKNOWN_NUMBER` supplies a synthetic unknown:

```sh
npm run test:carriers:live -- carriers/flickpost/adapter.live.test.ts
```
