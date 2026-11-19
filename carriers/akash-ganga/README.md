# Akash Ganga Courier

Akash Ganga Courier parcels use enabled universal providers. There is no dedicated adapter.

Akash Ganga Courier is a domestic courier network in India, based in New Delhi.

## Numbers

The tracking field on the home page takes any AWB number up to one hundred characters. A
lookup archived from the carrier's older tracker and customer complaints show eight-digit
consignment numbers, and a later complaint shows a nine-digit one. Digit runs of these lengths
are printed by many other carriers, so no rule claims them.

## Retrieval lead

The tracker is `agcgroup.in/track-now/`, whose form sends the number as `awb` by GET. The
older site at `akashganga.info` no longer answers. No found reply has been seen, so there is no
adapter.

## Links

The tracker carries the number as `awb` on `agcgroup.in/track-now/`. Links to the older site
carry it as `AWB` on `Tracking.aspx` or `ConNo` on `OnlineTracking.aspx`; the number is read
from all three.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
