# Benniao Express

Tracks Benniao Express (笨鸟速运), a Chinese parcel network with hubs across the country, through
the waybill search on its own site.

## How it works

The site's search opens `https://www.benniaosuyun.com/?search/&keyword=<waybill>`, whose script
posts `{"nums": ["<waybill>"]}` to
`https://bnsy.benniaosuyun.com/api/officialWebSitePortal/findWaybillTrack`. It signs the request
with two headers: `X-Timestamp`, the millisecond clock, and `X-Signature`, the MD5 of the JSON body
followed by `&timestamp=` and that clock (`/static/js/api.js`). `direct` sends the same signed
request with no session, captcha or account. A request that fails to reach the server gets one
`retry` in the rest of the budget. A refused signature is a challenge, since it means the page's
scheme changed.

The reply names the waybill without its BN, and must name the whole waybill asked. An unknown
waybill comes back with no history. Rows are oldest first on China wall clocks, each with its city
as the location. A row's scan, such as 已到达, is its code. The wording leaves out the phone numbers
in brackets after each branch, the courier, the signatory and the customer service notice.

An interception (已操作拦截扫描), usually on the sender's request, and a problem scan
(已操作问题件扫描) are exceptions; a parcel stopped this way often travels back and is signed for
later.

## Limitations

Waybills are BN and fourteen digits, which detection names. The endpoint also takes the fourteen
digits alone, a shape other carriers share, so those need explicit selection.

## Testing

`BENNIAO_EXPRESS_TRACKING_NUMBER=… BENNIAO_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/benniao-express`
