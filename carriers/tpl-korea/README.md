# TPL Korea

TPL Korea, also branded TBorder, consolidates and transports international purchases to Korea. Select the carrier explicitly and enter the house waybill.

The [carrier FAQ](https://www.tplkorea.com/cs/faq) publishes the guest route and a live example. The public [TBorder form](https://www.tborder.com/) opens the same numbered tracking page. The returned panel identifies the waybill and highlights completed stages in a progress bar.

The adapter reports the last completed stage. The published waybill currently shows `항공운송중` (in air transit). The progress bar supplies no scan times or scan locations, so the result is a status summary.

Run the opt-in live check with the published waybill.

```sh
TPL_KOREA_TRACKING_NUMBER=6076825053198 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/tpl-korea/adapter.live.test.ts
```
