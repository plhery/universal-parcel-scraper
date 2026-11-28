# TRAWL source

The Dockerfile extends germondai/trawl at tag `v1.12.0`, commit
`99f90c9a14d9730658f4c51f14ce7503c4c18523`, with the image digest pinned in [Dockerfile](Dockerfile).
[Upstream source](https://github.com/germondai/trawl/tree/99f90c9a14d9730658f4c51f14ce7503c4c18523)
and [source archive](https://github.com/germondai/trawl/archive/99f90c9a14d9730658f4c51f14ce7503c4c18523.tar.gz).

The patches, installation script and build instructions live in this folder and are distributed
under [AGPL-3.0](LICENSE). Release builds attach the matching upstream and patch source archives.
Keep that source available with any redistributed image.

ZTO's offline character worker uses [ddddocr](https://github.com/sml2h3/ddddocr)
(MIT) and [RapidOCR](https://github.com/RapidAI/RapidOCR) (Apache-2.0), with their
bundled models. The Dockerfile pins the Python runtime and package versions;
the installed distributions retain their license files. Models run locally and
are confined to the optional TRAWL image.

The reCAPTCHA picture solver uses [YOLOX](https://github.com/Megvii-BaseDetection/YOLOX)'s
YOLOX-M COCO model (Apache-2.0), release `0.1.1rc0`. The Dockerfile fetches the ONNX model and
the license by checksum into `/opt/recaptcha-image` and runs it with the pinned ONNX Runtime.
