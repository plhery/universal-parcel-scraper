# Fixtures

`digits-refused.json` is the reply of `trackingCustomerByWaybillNo/v_7` to phone digits that
are not the parcel's, which is also its reply for a waybill J&T Express China does not know.

`delivered.json` and `without-scans.json` have the shape of `v_7`'s answer as the tracking
page's script reads it: one answer per waybill in `data`, naming it in `keyword`, with the
second stage's `code`, the towns, an exception notice and the scans in `details`, newest
first. `second-stage.json` is the shape of `v_5`'s answer for the waybill of
`without-scans.json`. The scans' sentences name couriers, a recipient and phone numbers, and
set places and people apart in 【】.

Waybills, codes, sentences, names, places, phone numbers, links and clocks are invented; the
statuses are those the page's script handles.
