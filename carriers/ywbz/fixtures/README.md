# Fixtures

The replies are `Service.ashx`'s JSONP for one number, as the adapter asks it, for the public
examples in [numbers.json](../numbers.json).

- `delivered.txt` is a parcel the line flew to the United States, where USPS delivered it. YWBZ's
  own scans in Yiwu state China's offset; the line's and USPS's state none, and USPS's open with
  their place and postcode.
- `handed-over.txt` is a parcel whose warehouse changed the last-mile vendor, naming SwiftX's
  number, while its flight was landing. Every scan states the offset of its place.
- `not-found.txt` is the answer for a number the tracker does not know.
