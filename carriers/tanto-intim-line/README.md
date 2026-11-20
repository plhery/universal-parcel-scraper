# Tanto Intim Line

Select Tanto Intim Line explicitly and enter the container number from the carrier's shipping paperwork. The [Tanto home page](https://www.tantonet.com/) provides the public Container Tracking form.

## Retrieval

The adapter sends the container number in the form's displayed format and checks the full number in the reply. The carrier returns one dated activity for the container. Its date has day precision.

The activity reflects the equipment movement Tanto currently reports. A container can sail more than once. Vessel boarding and arrival at the discharge port count as transit.

## Testing

`TANTO_INTIM_LINE_TRACKING_NUMBER=… TANTO_INTIM_LINE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/tanto-intim-line`
