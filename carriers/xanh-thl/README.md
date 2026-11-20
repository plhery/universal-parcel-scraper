# Xanh THL Logistics

Select Xanh THL Logistics and enter the waybill below the QR code on the label. The adapter loads the anonymous WordPress form and its current script, posts the waybill, and verifies the full number in the reply. The tracking link opens the form on the carrier’s home page. [Official tracker](https://xanhthl.com/#xanhTrackingForm) · [Official tracking walkthrough](https://xanhthl.com/huong-dan-tra-cuu-van-don-tracking-bill/)

The published waybill returned its pickup and a later movement from the same Hồ Chí Minh office. The adapter keeps the carrier’s minute-only local clocks and scanning office names. It reports “Delivery in progress” as transit because the example uses it at the origin office. Contact details, notes, recipients and related numbers stay out of the result.

```sh
XANH_THL_TRACKING_NUMBER=X00000213 XANH_THL_UNKNOWN_NUMBER=X00000000 npm run test:carriers:live -- carriers/xanh-thl
```
