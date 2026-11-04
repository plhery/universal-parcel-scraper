# TRAWL source

The Dockerfile extends germondai/trawl at tag `v1.10.0`, commit
`fc3f64a7eebc9776c39bad1b5ed72b461cd3cdbb`, with the image digest pinned in [Dockerfile](Dockerfile).
[Upstream source](https://github.com/germondai/trawl/tree/fc3f64a7eebc9776c39bad1b5ed72b461cd3cdbb)
and [source archive](https://github.com/germondai/trawl/archive/fc3f64a7eebc9776c39bad1b5ed72b461cd3cdbb.tar.gz).

The patches, installation script and build instructions live in this folder and are distributed
under [AGPL-3.0](LICENSE). Release builds attach the matching upstream and patch source archives.
Keep that source available with any redistributed image.

ZTO's offline character worker uses [ddddocr](https://github.com/sml2h3/ddddocr)
(MIT) and [RapidOCR](https://github.com/RapidAI/RapidOCR) (Apache-2.0), with their
bundled models. The Dockerfile pins the Python runtime and package versions;
the installed distributions retain their license files. Models run locally and
are confined to the optional TRAWL image.
