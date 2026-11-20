# VNPost captcha model

`captcha.onnx` reads the four characters of VNPost's tracker pictures. It is part of this project
and shares its license.

The tracker draws its pictures with [mews/captcha](https://github.com/mewebstudio/captcha/tree/7154a930e88bdb7b02630b14105c5b7b3ecc7fb4)
(MIT) at 100 by 40 pixels: four characters from the 62 Latin letters and digits, each at its own
size, font, colour and angle, and a magenta line. [train.py](train.py) draws pictures the same way
with that package's six fonts and trains a small convolutional network on them alone; no picture
from the tracker is used for training.

The export uses opset 17, input `image` with shape `[1,3,40,100]` holding RGB values from 0 to 255,
and output `logits` with shape `[1,4,62]`, one row per place over the characters in
[ocr-worker.mjs](../ocr-worker.mjs)'s order. It contains inference weights only.
