# Certipostal

Certipostal S.A.S. operates physical express mail in Colombia. Select Certipostal explicitly and enter the complete guide number printed on the carrier label. The samples in [numbers.json](numbers.json) come from public Colombian government records for physical mail.

The [carrier tracking page](https://certipostal.com/seguimientos/fivepostal/) embeds the Certipostal FivePostal tenant. Its public guide form opens `tag_detail_v1.html?d={trackingNumber}`. The numbered page discovers the tenant API through `modules/tag/ajax.class.php`. The adapter calls the observed guest endpoint at `certi2.api.fivesoftcolombia.com` and checks the guide on both the shipment and its movements.

History uses the Colombian local dates and times displayed by the tracker. They are scan record times and can follow the actual delivery. The parser filters out certificate activity, guide digitization and manifest preparation. It keeps return outcomes and explicit deliveries, including delivery scans without an image. A generic handling scan carries no stage. Fixtures contain guide identifiers, scan clocks, cities and standard status labels. The adapter does not fetch proof images or read contact details, geolocation, or observations. Use physical Certipostal guides for this adapter. Fivemail email confirmations have a separate service and are outside its scope.

Run the live test with a published physical guide number.

```sh
CERTIPOSTAL_DELIVERED_NUMBER=4083638600015 CERTIPOSTAL_RETURNED_NUMBER=3922901001775 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/certipostal/adapter.live.test.ts
```
