# Heung-A Line

Select Heung-A Line explicitly and enter the full carrier-issued bill of lading number, including its HASL prefix. The [Heung-A e-Service tracking page](https://ebiz.heungaline.com/Tracking) provides public bill tracking.

## Retrieval

The adapter checks that the booking exists and then reads the movement table for the same bill. It verifies the returned bill field and document references in the table. The result keeps dated actual movements and their printed local times.

Vessel departure and arrival count as transit. The carrier uses identical equipment pickup and return labels at both ends of the voyage. These scans and administrative document milestones appear in the history without a parcel stage.

## Testing

`HEUNG_A_LINE_TRACKING_NUMBER=… HEUNG_A_LINE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/heung-a-line`
