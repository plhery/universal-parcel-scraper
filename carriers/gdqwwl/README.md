# Quanwang Logistics

Quanwang Logistics (广东全网物流) is a less-than-truckload platform in Guzhen, Zhongshan, that pools some thirty
direct freight lines from the town's lighting trade to China's provincial capitals. Its site is gdqwwl.com.

## How it works

The tracker is the firm's WeChat page on `wx.gdqwwl.com:8080`, an XBM form that the home page no longer links.

1. `direct`: a GET of `/XBM_RootDir/TPL_Base/FORM_99_5.bsp` gives the form's opaque references (`ViewState`,
   `Action` and the reference its button submits), then a POST to `XBM_Service.bsp?EXEC` sends them with the
   number and an empty name or phone. No session, cookie, account or captcha.
2. `retry`: the same lookup once more when the first fails to reach the tracker or hangs.

The tracker answers plain HTTP only.

The page shows the waybill's fields, then its rows oldest first: a time, a Chinese wording, and the handler,
plate, driver, phone and remark, which are not read. A number the system holds nothing for gets the same page with
every field empty and no rows, read as not found. A page whose waybill or hand-written number is not the one asked
is indeterminate, so a lookup by the hand-written number works too.

## Notes

- The rows keep their wall clock; the page gives no zone.
- A signature row names the signatory after `签收人：`; the adapter leaves the name and any phone out.
- The city a row says the freight reached is its location.
- The wordings are staged by `statuses.json`, whose `{place}` stands for the shipper or the city; others fall
  to the shared wording rules. The page's status menu is not read.

## Limitations

No delivery estimate. The destination region, goods and parties on the page are not returned.

## Numbers

The public example is twelve digits, a date and a serial, a shape many carriers share, so there is no detection
rule and no recognition: a lookup asks Quanwang only when the user picks it.

## Links

The tracker is plain HTTP and takes the number by a form post, so no portal link is published, and the canary
checks Kuaidi100's page for the firm.

## Testing

`npm run test:carriers:live -- carriers/gdqwwl` reads the public sample, or `GDQWWL_TRACKING_NUMBER`.
