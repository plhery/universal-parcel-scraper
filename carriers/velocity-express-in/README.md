# Velocity Express

The adapter tracks Velocity Express India's airway bills through the public `/trackAWB/`
endpoint on velexp.com. Select the carrier explicitly. The shipment and every history row must
repeat the airway bill. The endpoint's HTTP 404 with its matching no-data JSON means the
shipment is unknown.

Scans use carrier status codes, city labels and local clocks. Exact duplicate scans appear
once. A remark that names who signed or a delivery code gives way to its status's wording. Order IDs use a separate lookup and are outside this adapter's scope.

Set `VELOCITY_EXPRESS_IN_TRACKING_NUMBER` and optionally `VELOCITY_EXPRESS_IN_UNKNOWN_NUMBER`
outside the repository and run `npm run test:carriers:live -- carriers/velocity-express-in`.
