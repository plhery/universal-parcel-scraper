# DTW Logistics

Tracks DTW Logistics (大田物流), a Beijing freight and supply-chain carrier with road, air and
cold-chain networks across China, through the waybill tracker its site frames.

## How it works

The site's 运单查询 page frames the form at `https://owtrack.dtw.com.cn/`, which redirects a
waybill to `CustomerScanQuery2023.aspx?w=<waybill>`. `direct` fetches that page with no
session, captcha or account. A request that fails to reach the server gets one `retry` in the
rest of the budget. The tracker finds a waybill only with its DTW prefix, so the adapter sends it
in capitals.

The summary table must name the whole waybill asked. Scans are listed newest first on China wall
clocks. A row's step, such as 货物进站, is its code and its station the location. On the road the
tracker adds a 货物在途 row about hourly, with the truck's city as the station and its nearest
landmark as a remark.

## Limitations

The sender, the recipient's address, the customer service agent, pieces, weight, the signatory,
the delivery images and the truck's landmarks are left out.

## Testing

`DATIAN_LOGISTICS_TRACKING_NUMBER=… DATIAN_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/datian-logistics`
