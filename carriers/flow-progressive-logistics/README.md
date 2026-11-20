# Flow Progressive Logistics

[FLOW's public tracker](https://www.flowpl.com/order-tracking/) takes its own waybill
number. The adapter submits the same form and matches the waybill displayed above
the history. The container, vessel and clearance tabs use separate forms.

The adapter preserves the carrier's original status wording and local times. The
free-text locations can contain street addresses, so the fixture and the adapter omit them.
Delivery scheduling and the short internal labels stay unstaged when the carrier
gives no clear shipping milestone.

The tracker renders the result after a form POST. The public link opens the form
for manual entry. Run the live test with `FLOW_PROGRESSIVE_LOGISTICS_TRACKING_NUMBER` set
and `npm run test:carriers:live -- carriers/flow-progressive-logistics`.
