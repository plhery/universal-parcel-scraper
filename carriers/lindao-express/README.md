# Lindao Express

Tracks Lindao Express (林道货运), a Shanghai forwarder flying parcels from China to Japan, where a
Japanese carrier delivers them, through the tracking page on its site.

## How it works

`direct` posts one number to `http://www.ldxpress.com/home/goods/index.html` as the page's form
does, with no session, captcha or account; the site answers over HTTP only. It fails with HTTP 500
on the `*` language `fetch` sends by default, so the request names Chinese. The reply names
Lindao's order number and the Japanese waybill the last leg travels under, one of which must be
the whole number asked, then lists the scans newest first; a page saying the order does not exist
is a number Lindao does not know. A request that fails to reach the server gets one `retry` in
the rest of the budget.

The rows are short fixed steps, in Chinese while the parcel is in China and in Japanese once it
lands, and the adapter keeps each as its code. An operations centre or airport a step names is its
location. Asked by the order number, the result names the Japanese waybill as
`delivery_tracking_number`.

## Limitations

Scans in China are on China's clock and those in Japan on Japan's, an hour ahead, and the page
does not say which; the rows keep the page's order. The page does not name the Japanese carrier.
Numbers are twelve digits, a shape many carriers share, so the carrier is never detected and needs
explicit selection.

## Testing

`LINDAO_EXPRESS_TRACKING_NUMBER=… LINDAO_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/lindao-express`
