# Fixtures

`delivered.json` and `delivered-parcels.json` are the replies of the tracker's
`/ope/rest/tracking/{number}` for the two public samples in `numbers.json`, without the staff
username on each scan. `delivered.json` is one parcel whose delivery appointment was booked,
cancelled and booked again; `delivered-parcels.json` is three parcels taken in at the destination
branch minutes apart and delivered together. `not-found.json` is the HTTP 404 body for a number
Golilla does not know.
