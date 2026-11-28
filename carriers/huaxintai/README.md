# Huaxintai Logistics

Huaxintai Logistics (华鑫泰物流) is a road freight firm whose waybills leave from its Shenyang branch.
It tracks them on the online tracking page of Keppon's TMS (科邦在线查询平台), on a host and port
of its own, which Kuaidi100's carrier list gives as the firm's tracker.

## How it works

1. `direct`: one `GET http://se.keppon.cn:8057/OnlineTrack.aspx?cid=3356&yid=<number>`, the page the
   firm's listing links with its tenant id, through the platform reader in
   [`keppon.ts`](keppon.ts). The server renders the waybill's summary and rows into the page.
2. `retry`: one more try when the request fails to reach the page or hangs.

- The summary row and the bold number over the rows must both be the number asked. The summary's
  line 没有搜到任何运单信息 is not found; a page without the summary is a changed page, or a challenge
  when it is a bot check.
- The page answers the same whatever `cid` it gets, and on the neighbouring port too: the host is
  the firm's, so the reader keeps the firm's own tenant id and port as its listing gives them.

## Notes

- The page is served over plain HTTP only, so the catalog gives no tracking link.
- Rows are oldest first on the page and dated on China's clock with `carrier` as the basis, each
  keeping its wall clock.
- A row that starts with a city in brackets has it as its location, and the platform leaves the
  brackets empty when it has none; the opening row names the branch's warehouse in brackets instead.
- The rows name the signer, which the reader drops, as it does drivers, plates and phones.
- [`keppon.ts`](keppon.ts) takes the firm's page and tenant id as parameters, so another firm on
  Keppon needs only its adapter and status map. Lanqiao's template reader
  ([`../anjiexin56/lqfastStatus.ts`](../anjiexin56/lqfastStatus.ts)) reads the wordings in
  [`statuses.json`](statuses.json), as the rows read alike.

## Limitations

- The progress bar under the rows (开单入库, 中转外发, …) and the summary's branches and state are not
  read; the rows carry the history.
- No destination or weight.

## Numbers

The waybill numbers are a counter of five and six digits, which says nothing about the firm, so no
rule claims them and the adapter answers explicit selection. It declares no recognition: the
counter is dense, so a waybill under a number does not show the parcel asked about is the firm's.
The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`HUAXINTAI_TRACKING_NUMBER=… HUAXINTAI_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/huaxintai`
