# InPost fixtures

- `delivered.json`: hub response for a delivered cross-border parcel (registration, middle
  mile, locker arrival, collection) with each scan's place, plus the recipient and signature
  fields the parser must drop. Constructed from the live hub shape; every identifier, name and address is synthetic.
