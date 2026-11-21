# Fixtures

Replies from the Goodrich Group's booking system behind Vasco Maritime's tracking page, for the public
samples in `numbers.json`, whole.

- `bill-VASKLFCOK000238.json` and `bill-VASJKTJEA001850.json`: each bill's header, from `GETBLDTLS`.
- `container-VMLU3201205.json`: the container's bill header, from `GETCONTAINERDTLS`.
- `moves-*.json`: each bill's containers and their moves, from `GETBLCONTAINERDTLS`. `VASTAOKLF083071`
  is the bill the container's reply names.
- `not-found.json`: the reply for an invented bill or container the tracker holds nothing for.
