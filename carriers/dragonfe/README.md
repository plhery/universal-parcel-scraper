# DF Logistics

DF Logistics (DF物流, Qingdao DragonFight International Supply Chain, 青岛安贞吉) consolidates parcels bought in
Japan and Korea at its warehouses there and flies them to China, where they clear customs. Its site is
dragonfe.com.

## How it works

1. `direct`: one GET of `/index.php/Home/Index/getExpTrack/expNo/<number>` on `www.dragonfe.com`, the page the
   home page's form opens in a frame. No session, cookie, account or browser.
2. `retry`: the same request once more when the first fails to reach the site or hangs.

The site answers plain HTTP only.

The page names the shipment (`快件<number>`), then gives a table per box of rows, oldest first, each a time
and a Chinese wording. An unknown number gets a table with the sentence `暂未查到包裹相关数据`, read as not
found only when the page names the number asked.

## Notes

- The rows keep their wall clock; the page gives no zone.
- The wordings are staged by `statuses.json`, whose `{station}` stands for the bracketed warehouse or city;
  others fall to the shared wording rules.
- The warehouse or city a row names in brackets is its location.

## Limitations

No delivery estimate, weight, sender, recipient or the Chinese courier that delivers after clearance.

## Numbers

The public example is the line's code and twelve digits, from one sample only, so there is no detection rule
and no recognition: a lookup asks DF Logistics only when the user picks it.

## Links

The tracker is plain HTTP, so no portal link is published, and the canary checks Kuaidi100's page for the
firm.

## Testing

`npm run test:carriers:live -- carriers/dragonfe` reads the public sample, or `DRAGONFE_TRACKING_NUMBER`.
