# Fixtures

`not-found.json` is the reply of `getDetailByWaybillNo` for a waybill J&T Express Mexico does
not know, and `digits-refused.json` its reply for a waybill it knows with phone digits that are
not the parcel's: each keeps the live reply's code and message.

`delivered.json` and `in-transit.json` have the shape the tracking page's script reads: the
answer in `data`, with the sender's and receiver's towns and the scans in `details`, newest
first, each with a time, a label and a sentence that sets places apart in 【】 or square
brackets. `delivered.json` goes from the pickup to the delivery, with one arrival repeated, and
its sentences name couriers, the recipient and a phone number. In `in-transit.json` the
pickup's sentence starts with a phone number in place of a place.

Labels, sentences, names, places, phone numbers and clocks are invented.
