# Fixtures

`shell.html` is a synthetic copy of the tracking page's HTML before the circuit renders it: the
markers of the two server components to start and the state they carry. The other files are
the page as Swire's server rendered it, written out from the circuit once its loader was gone:

- `bl-AS00249400.html`, `bl-WS00104400.html` and `bl-TO00059000.html` are the public sample
  bills, with ten containers, three and one. The page opens one container with its moves and
  shows each other one's latest move.
- `container-BEAU2731911.html` is a container of the first bill, looked up as a container.
- `not-found.html` is the page's answer to a bill it does not hold, one importinfo lists for
  LAUTOKA CHIEF (https://www.importinfo.com/vessel/lautoka-chief/9868431) in another shape.

The tests edit these pages, as invented changes, and turn them into render batches served over a
fake hub.
