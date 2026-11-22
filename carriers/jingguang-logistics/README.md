# Jingguang Logistics

Tracks Jingguang Logistics (景光物流), a less-than-truckload freight network in Guangdong and
southern China, through the waybill search on its site.

## How it works

`direct` sends `GET https://www.jgwl.cn/wx/websiteorderticket.aspx?code=…&key=…&billcode=<waybill>`,
the request the search page at `https://www.jgwl.cn/service/querybill` makes, with no session or
account. The page draws a four-character code on a canvas and sends it beside `key`, the code and
the time encrypted with AES-256-CBC under a key and IV its script gives every visitor. The server
compares the two and never issues the code, so the adapter draws its own and encrypts it the same
way with WebCrypto. A request that fails to reach the server gets one `retry` with a new code in
the rest of the budget.

The reply lists the scans for the waybill, each naming it, on China wall clocks and not always in
clock order. A row has no scan code, so the adapter names it after the phrase its wording is built
around, such as 已到达 or 已签收, and takes the branch the wording brackets as its location. The
delivery row's branch phone numbers and the signatory are removed.

## Limitations

Waybills are eight digits, a shape other carriers share, so the carrier is never detected and
needs explicit selection. The destination city and the origin branch's phone numbers that every
row carries are left out.

## Testing

`JINGGUANG_LOGISTICS_TRACKING_NUMBER=… JINGGUANG_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/jingguang-logistics`
