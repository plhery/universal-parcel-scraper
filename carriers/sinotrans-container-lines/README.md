# Sinotrans Container Lines

Select Sinotrans Container Lines and enter an equipment number from the [public cargo tracker](https://ebusiness.sinolines.com.cn/Ebusiness/EQUERY/TrackingCargoE.aspx?subject=BLNO). In the site's query mode, choose **Container Number**. The site also accepts bills of lading and may ask for the matching container. This adapter takes one container number.

The adapter loads the guest form and sends its anonymous ASP.NET form state with the container. It checks the number in every movement row and preserves the port's local clock. Loaded gate and vessel movements count as transit. Empty equipment movements, off-hire, and routing a full box toward the receiver cannot confirm parcel handover.

The carrier's [guide](https://ebusiness.sinolines.com.cn/snlebusiness/download/Eguide_surchargesinquiry.pdf#page=6) shows container `SNBU2185474`. The guest form still returned 50 dated movements when checked on November 20, 2026.

```sh
SINOTRANS_CONTAINER_LINES_TRACKING_NUMBER=SNBU2185474 SINOTRANS_CONTAINER_LINES_UNKNOWN_NUMBER=ABCU0000000 npm run test:carriers:live -- carriers/sinotrans-container-lines
```
