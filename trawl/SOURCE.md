# TRAWL source

The Dockerfile extends germondai/trawl at tag `v1.11.1`, commit
`b48f1e8663bdd19878645648c25ef0ab99d0c5e0`, with the image digest pinned in [Dockerfile](Dockerfile).
[Upstream source](https://github.com/germondai/trawl/tree/b48f1e8663bdd19878645648c25ef0ab99d0c5e0)
and [source archive](https://github.com/germondai/trawl/archive/b48f1e8663bdd19878645648c25ef0ab99d0c5e0.tar.gz).

The patches, installation script and build instructions live in this folder and are distributed
under [AGPL-3.0](LICENSE). Release builds attach the matching upstream and patch source archives.
Keep that source available with any redistributed image.

ZTO's offline character worker uses [ddddocr](https://github.com/sml2h3/ddddocr)
(MIT) and [RapidOCR](https://github.com/RapidAI/RapidOCR) (Apache-2.0), with their
bundled models. The Dockerfile pins the Python runtime and package versions;
the installed distributions retain their license files. Models run locally and
are confined to the optional TRAWL image.
