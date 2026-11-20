# Pasha Hawaii

Pasha Hawaii carries cargo between the US mainland and Hawaii. Select it explicitly with a container number or a Pasha Hawaii bill of lading. The [public tracker](https://www.pashahawaiishipping.com/public/track.htm) accepts both references through a guest form. A bill may be entered with the carrier's `PHWC` prefix. The adapter removes that prefix before submitting the bill.

The container results describe movements of the equipment, which can span several separate shipments. A loaded import delivery remains in the history when the empty equipment is subsequently moved. The bill results show the most recent recorded movement of each listed container. They provide calendar dates, while the equipment history also shows local scan times. An empty return to the terminal or sale of the equipment remains a carrier description without a parcel stage.

The first equipment sample comes from a [public equipment photo](https://www.matts-place.com/intermodal/part1/refrig40.htm). Pasha Hawaii's guest equipment results list the associated bill. A separate bill search confirms the reference and its link to that container. Fixtures preserve the movement rows and omit booking, vessel, cargo weight and similar fields unrelated to the tracking result.

Run the opt-in live checks with the public references.

```sh
PASHA_HAWAII_CONTAINER_NUMBER=PGHU5003080 PASHA_HAWAII_BILL_NUMBER=573230110069 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/pasha-hawaii/adapter.live.test.ts
```
