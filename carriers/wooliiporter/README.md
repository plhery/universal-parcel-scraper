# WooliiPorter

WooliiPorter forwards parcels bought in China, such as Taobao, 1688 and JD orders, from its
Chinese warehouse to buyers abroad, and fulfils orders for merchants. It gives each shipment one
public number for every leg and merges its partners' scans under it. Its site is woolii.com.

## Numbers

The tracking page takes `WP` and thirteen digits, the last a Luhn check digit of the twelve before
it, and checks the digit before it asks. It also takes `WPTRK-` references. The page's own example
is the only public number, so the rule offering WooliiPorter for `WP` and thirteen digits is low.
It does not check the digit: the catalog's Luhn check reads digits only. The adapter does, and
asks nothing for a number the page would refuse. Recognition asks the same lookup for `WP` numbers.

## Retrieval

The adapter makes the tracking page's request, `GET https://woolii.com/api/public/tracking/{number}`,
which needs no cookie, token or CAPTCHA. A request that fails to reach the service gets one more
within the deadline.

The reply names the shipment's public number, its carrier, a status code and the scans, each
with an instant, English wording, a place and a status code. It must name the number asked; for a
`WPTRK-` reference it may name the shipment's `WP` number, which becomes the canonical number. The
stages come from the codes the page's script lists; the scan's wording is shown, or the page's
label for its code when it has none. The carrier's name is not read: no public reply shows what it
holds. A shipment without scans has been created but not yet scanned and has no history. Only
HTTP 404 with the service's error `Tracking number not found`, or its earlier `Tracking not found`, is
not found.

No public number shows a shipment, so the parser follows the page's script and synthetic fixtures.

## Links

A woolii.com link to `/track/<number>` names WooliiPorter, and the page tracks the number it
holds. A link holding several numbers is not read.

## Testing

Set `WOOLIIPORTER_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/wooliiporter/adapter.live.test.ts`. The page's example
number is read as not found without it.
