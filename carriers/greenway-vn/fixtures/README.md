`in-transit.json` is synthetic. It follows the fields the tracking page's script reads from the logs lookup:
`packages` with `id`, `package_code.code`, `status_string`, `country_code`, `alert`, `checkin_warehouse_at`,
`delivered_at` and `tracking`, and `logs` with `package_id`, `ship_time`, `location` and `description`. The package,
its last-mile number and its logs are the examples of a package lookup and of a package history in Greenway's API
documentation, docs.greenwayvn.com/openapi3.yaml, which writes an unset clock as the year 1. `not-found.json` is the
lookup's reply to a code it does not hold, as it answers the documentation's examples.
