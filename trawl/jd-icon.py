"""Locate a single JD verification icon without retaining image data."""

import base64
import io
import json
import sys

import cv2
import numpy as np
from PIL import Image

cv2.setNumThreads(1)


def decode(value, size):
    if (
        not isinstance(value, str)
        or not value.startswith("data:image/")
        or len(value) > 200000
    ):
        raise ValueError("image")
    data = base64.b64decode(value.split(",", 1)[1], validate=True)
    with Image.open(io.BytesIO(data)) as header:
        if header.size != size or header.format not in ("PNG", "JPEG"):
            raise ValueError("geometry")
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image")
    return image


def solve(payload):
    scene, tip = decode(payload["scene"], (275, 170)), decode(payload["tip"], (108, 36))
    cv2.setRNGSeed(7)
    mask = np.zeros((36, 108), np.uint8)
    bg = np.zeros((1, 65), np.float64)
    fg = bg.copy()
    cv2.grabCut(tip, mask, (34, 0, 40, 36), bg, fg, 6, cv2.GC_INIT_WITH_RECT)
    fore = ((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)).astype(np.uint8)
    count = int(fore.sum())
    if count < 60 or count > 900:
        return {
            "acceptedPlan": False,
            "failure": "foreground",
            "foregroundPixels": count,
        }
    glyph = fore[:, 36:72]
    lab = cv2.cvtColor(tip, cv2.COLOR_BGR2LAB).astype(np.float32)
    sl = cv2.cvtColor(scene, cv2.COLOR_BGR2LAB).astype(np.float32)
    scene_energy = np.sum(sl * sl, axis=2)
    color = lab[:, 36:72]
    ys, xs = np.where(glyph > 0)
    proposals = []
    # Match the arrangement of foreground colours first. A palette mask alone
    # also selects photographic background with similar colours.
    for scale in np.arange(0.7, 1.61, 0.1):
        for angle in range(0, 360, 10):
            size = int(np.ceil(52 * scale))
            matrix = cv2.getRotationMatrix2D((18, 18), angle, scale)
            matrix[:, 2] += (size - 36) / 2
            template = cv2.warpAffine(
                glyph, matrix, (size, size), flags=cv2.INTER_NEAREST
            )
            fy, fx = np.where(template > 0)
            if len(fx) < 30:
                continue
            lx, ly, hx, hy = (
                int(fx.min()),
                int(fy.min()),
                int(fx.max()) + 1,
                int(fy.max()) + 1,
            )
            # Empty rotation-canvas padding must not exclude edge icons.
            template = template[ly:hy, lx:hx]
            matrix[:, 2] -= (lx, ly)
            colored = cv2.warpAffine(
                color, matrix, (hx - lx, hy - ly), flags=cv2.INTER_LINEAR
            )
            # Expand masked squared distance so the scene's squared colours
            # are computed once, rather than for every rotation and scale.
            weights = template.astype(np.float32)
            weighted = colored * weights[:, :, None]
            err = (
                cv2.matchTemplate(scene_energy, weights, cv2.TM_CCORR)
                - 2 * cv2.matchTemplate(sl, weighted, cv2.TM_CCORR)
                + np.sum(colored * weighted)
            ) / template.sum()
            for _ in range(2):
                error, _, pos, _ = cv2.minMaxLoc(err)
                x, y = pos
                cv2.circle(err, pos, 20, float("inf"), -1)
                coords = np.column_stack(
                    (xs, ys, np.ones(len(xs)))
                ) @ matrix.T + np.array([x, y])
                valid = (
                    (coords[:, 0] >= 0)
                    & (coords[:, 0] <= 274)
                    & (coords[:, 1] >= 0)
                    & (coords[:, 1] <= 169)
                )
                if not valid.all():
                    continue
                # Rotated/scaled samples fall between pixels. Keep colour and
                # shape in the same pose, with interpolated colour samples.
                sampled = cv2.remap(
                    sl,
                    coords[:, 0].astype(np.float32).reshape(1, -1),
                    coords[:, 1].astype(np.float32).reshape(1, -1),
                    cv2.INTER_LINEAR,
                )[0]
                agreement = float(
                    (np.linalg.norm(lab[ys, xs + 36] - sampled, axis=1) < 35).mean()
                )
                if agreement < 0.75:
                    continue
                center = matrix @ np.array([18, 18, 1]) + pos
                proposals.append(
                    {
                        "error": float(error),
                        "agreement": agreement,
                        "x": float(center[0]),
                        "y": float(center[1]),
                        "left": x,
                        "top": y,
                        "template": template,
                    }
                )
    proposals.sort(key=lambda p: p["error"])
    regions = []
    for prop in proposals:
        region = next(
            (
                r
                for r in regions
                if np.hypot(r[0]["x"] - prop["x"], r[0]["y"] - prop["y"]) < 20
            ),
            None,
        )
        if region is not None:
            if len(region) < 6:
                region.append(prop)
        elif len(regions) < 5:
            regions.append([prop])
        else:
            # Do not hide an unexamined competitor when the region cap is hit.
            return {"acceptedPlan": False, "failure": "ambiguous"}
    valid = []
    for region in regions:
        best = region[0]
        t = best["template"]
        halo = 5
        left = max(0, best["left"] - halo)
        top = max(0, best["top"] - halo)
        right = min(275, best["left"] + t.shape[1] + halo)
        bottom = min(170, best["top"] + t.shape[0] + halo)
        smask = np.zeros(scene.shape[:2], np.uint8)
        b = np.zeros((1, 65), np.float64)
        f = b.copy()
        # Segment the actual scene independently from a bounding rectangle.
        # Never seed its foreground with the shape we are trying to confirm.
        cv2.grabCut(
            scene,
            smask,
            (left, top, right - left, bottom - top),
            b,
            f,
            4,
            cv2.GC_INIT_WITH_RECT,
        )
        sf = ((smask == cv2.GC_FGD) | (smask == cv2.GC_PR_FGD)).astype(np.uint8)
        for prop in region:
            t = prop["template"]
            x, y = prop["left"], prop["top"]
            actual = sf[y : y + t.shape[0], x : x + t.shape[1]]
            intersection = int((actual * t).sum())
            iou = intersection / max(1, int(t.sum() + sf.sum() - intersection))
            prop["iou"] = iou
        best = max(region, key=lambda p: p["iou"])
        best["regionAgreement"] = max(prop["agreement"] for prop in region)
        valid.append(best)
    valid.sort(key=lambda p: p["iou"], reverse=True)
    if not valid:
        return {"acceptedPlan": False, "failure": "ambiguous"}
    best = valid[0]
    competitor = valid[1]["iou"] if len(valid) > 1 else 0
    # Segmentation can lose part of a second icon, especially at an edge.
    # Its equally convincing colour pattern must still prevent a unique plan.
    color_competitor = max((p["regionAgreement"] for p in valid[1:]), default=0)
    accepted = (
        best["iou"] >= 0.62
        and best["iou"] - competitor >= 0.12
        and best["agreement"] - color_competitor >= 0.12
    )
    return {
        "acceptedPlan": accepted,
        "x": best["x"],
        "y": best["y"],
        "iou": best["iou"],
        "colorAgreement": best["agreement"],
        "margin": best["iou"] - competitor,
        "colorMargin": best["agreement"] - color_competitor,
    }


def locate(payload):
    result = solve(payload)
    return (
        {key: result[key] for key in ("x", "y")} if result.get("acceptedPlan") else None
    )


def reply(payload):
    """A point, or only why the matcher declined: a prompt or scene in another layout,
    an unreadable image, no icon in the prompt, no pose, or no clear winner."""
    try:
        result = solve(payload)
    except ValueError as error:
        return {"failure": "geometry" if str(error) == "geometry" else "image"}
    if result.get("acceptedPlan"):
        return {key: result[key] for key in ("x", "y")}
    failure = result.get("failure", "ambiguous")
    return {
        "failure": failure,
        **(
            {"foregroundPixels": result["foregroundPixels"]}
            if failure == "foreground"
            else {}
        ),
    }


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(500_001)
        if len(raw) > 500_000:
            raise ValueError("Image input too large")
        print(json.dumps(reply(json.loads(raw))))
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        OSError,
        cv2.error,
        Image.DecompressionBombError,
    ):
        print("null")
