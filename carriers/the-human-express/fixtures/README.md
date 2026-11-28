`in-transit.json` is synthetic. It follows the fields the tracking page's script reads from the logs lookup:
`packages` with `id`, `package_code.code`, `status_string`, `country_code` and `alert`, and `logs` with
`package_id`, `ship_time`, `location` and `description`. The package and its logs are the examples of a package
lookup and of a package history in The Human Express's API documentation, docs.thehuman.express/openapi3.yaml.
`not-found.json` is the lookup's reply to a code it does not hold, as it answers the documentation's examples.
