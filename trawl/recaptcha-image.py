"""Find one COCO class in reCAPTCHA picture tiles, without retaining image data."""

import base64
import io
import json
import os
import sys

import cv2
import numpy as np
import onnxruntime
from PIL import Image

cv2.setNumThreads(1)
MODEL = os.environ.get("RECAPTCHA_IMAGE_MODEL", "/opt/recaptcha-image/yolox_m.onnx")
SIZE = 640
STRIDES = (8, 16, 32)
MAX_IMAGE = 2_000_000


def decode(value):
    if not isinstance(value, str) or not value.startswith("data:image/png;base64,") or len(value) > MAX_IMAGE:
        raise ValueError("image")
    data = base64.b64decode(value.split(",", 1)[1], validate=True)
    with Image.open(io.BytesIO(data)) as header:
        width, height = header.size
        if header.format != "PNG" or not (32 <= width <= 1200 and 32 <= height <= 1200):
            raise ValueError("geometry")
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image")
    return image


def grids():
    cells, strides = [], []
    for stride in STRIDES:
        side = SIZE // stride
        ys, xs = np.mgrid[:side, :side]
        cells.append(np.stack((xs, ys), 2).reshape(-1, 2))
        strides.append(np.full((side * side, 1), stride))
    return np.concatenate(cells).astype(np.float32), np.concatenate(strides).astype(np.float32)


GRID, STRIDE = grids()


def detect(session, image, wanted, threshold):
    """Boxes of the wanted class in image pixels, as YOLOX's own demo decodes them."""
    height, width = image.shape[:2]
    ratio = min(SIZE / height, SIZE / width)
    padded = np.full((SIZE, SIZE, 3), 114, np.uint8)
    resized = cv2.resize(image, (int(width * ratio), int(height * ratio)), interpolation=cv2.INTER_LINEAR)
    padded[: resized.shape[0], : resized.shape[1]] = resized
    blob = padded.transpose(2, 0, 1)[None].astype(np.float32)
    output = session.run(None, {session.get_inputs()[0].name: blob})[0][0]
    centres = (output[:, :2] + GRID) * STRIDE
    sides = np.exp(np.clip(output[:, 2:4], -10, 10)) * STRIDE
    scores = output[:, 4] * output[:, 5 + wanted]
    keep = scores >= threshold
    if not keep.any():
        return []
    centres, sides, scores = centres[keep], sides[keep], scores[keep]
    boxes = np.concatenate((centres - sides / 2, centres + sides / 2), 1) / ratio
    chosen = cv2.dnn.NMSBoxes(
        [[float(x1), float(y1), float(x2 - x1), float(y2 - y1)] for x1, y1, x2, y2 in boxes],
        scores.tolist(), threshold, 0.45,
    )
    found = []
    for index in np.array(chosen).reshape(-1)[:50]:
        x1, y1, x2, y2 = boxes[index]
        found.append([
            round(float(np.clip(x1, 0, width)), 1), round(float(np.clip(y1, 0, height)), 1),
            round(float(np.clip(x2, 0, width)), 1), round(float(np.clip(y2, 0, height)), 1),
            round(float(scores[index]), 3),
        ])
    return found


def solve(payload, session):
    wanted, threshold = payload["class"], payload.get("threshold", 0.25)
    if not isinstance(wanted, int) or isinstance(wanted, bool) or not 0 <= wanted < 80:
        raise ValueError("class")
    if not isinstance(threshold, (int, float)) or not 0.05 <= threshold <= 0.9:
        raise ValueError("threshold")
    image, crops = decode(payload["image"]), payload["crops"]
    height, width = image.shape[:2]
    if not isinstance(crops, list) or not 1 <= len(crops) <= 16:
        raise ValueError("crops")
    boxes = []
    for crop in crops:
        if not isinstance(crop, list) or len(crop) != 4 or not all(isinstance(v, int) and not isinstance(v, bool) for v in crop):
            raise ValueError("crop")
        x, y, w, h = crop
        if x < 0 or y < 0 or w < 16 or h < 16 or x + w > width or y + h > height:
            raise ValueError("crop")
        boxes.append(detect(session, image[y : y + h, x : x + w], wanted, threshold))
    return {"boxes": boxes}


def main():
    payload = json.loads(sys.stdin.read(MAX_IMAGE + 4096))
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = onnxruntime.InferenceSession(MODEL, options, providers=["CPUExecutionProvider"])
    print(json.dumps(solve(payload, session), separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
