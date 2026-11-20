# Swift Drop

Swift Drop delivers parcels and documents across the United Arab Emirates. The adapter reads
the current milestone from the English guest tracking page and checks the order number
printed beside it. The carrier's published demo opens through that same number-based route.

A missing-order page must name the requested number. A changed page or mismatched order is
a lookup failure. A driver assigned to pickup has yet to take possession of the parcel.

The page's progress rail has no scan times. The adapter returns the current status and leaves
out the relative arrival countdown and driver details. The catalog opens the search form
because the result URL requires the hyphen that the SDK strips from a stored number.

Run a live check with `SWIFT_DROP_AE_NUMBER` supplied in the environment and
`npm run test:carriers:live -- carriers/swift-drop-ae`.
