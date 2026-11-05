# FXDC Post

The native adapter reads the anonymous `/klant/volgen?ref=…` page on `my.fxdc-post.com` for the
verified Punto Mio forwarding service. The form and separate result identifier must both match,
and the service branding and own Miami receipt must be consistent. Postal and other service
references remain with enabled universal providers until a positive control establishes them.
There is no broad numeric detection rule.

The page supplies a current status and update day beside an undated progress diagram. The adapter
returns a partial summary with no invented scan history, midnight or delivery instant, so a richer
provider history can still be used. The labelled mass is converted from its stated unit; commodity
text is omitted. The explicit number-bound unknown message is distinct
from malformed replies, refusals and rate limits.

Retrieval uses the caller's transport and budget, with one network-only retry.

Run `FXDC_POST_TRACKING_NUMBER=… FXDC_POST_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/fxdc-post/adapter.live.test.ts` with private inputs.
