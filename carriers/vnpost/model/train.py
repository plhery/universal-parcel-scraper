"""Trains captcha.onnx on pictures drawn the way VNPost's tracker draws them.

Usage: python train.py <mews/captcha fonts folder> <steps> <captcha.onnx>
Needs Pillow, NumPy and PyTorch. The fonts are the six in mews/captcha's assets/fonts.
"""
import glob, io, os, random, sys, time
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F
from PIL import Image, ImageDraw, ImageFont
from torch.utils.data import DataLoader, IterableDataset

CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
COLORS = ['#2c3e50', '#c0392b', '#16a085', '#c0392b', '#8e44ad', '#303f9f', '#f57c00', '#795548']
W, H, LEN = 100, 40, 4
FONTS = sorted(glob.glob(os.path.join(sys.argv[1], '*.ttf'))) if len(sys.argv) > 1 else []
_fonts = {}


def font(path, px):
    if (path, px) not in _fonts:
        face = ImageFont.truetype(path, px)
        _fonts[path, px] = (face, -face.getbbox('T', anchor='ls')[1])
    return _fonts[path, px]


def render(rng):
    """One picture as mews/captcha draws it: each character at its own size, font, colour and angle, then a magenta line."""
    text = ''.join(rng.choice(CHARS) for _ in range(LEN))
    img = Image.new('RGB', (W, H), (236, 242, 244))
    for k, ch in enumerate(text):
        # A font size from H - 10 to H points, which GD draws at 0.76 of a point per pixel at 96 dpi.
        px = max(8, round(rng.randint(H - 10, H) * 0.76 * 96 / 72 + rng.uniform(-0.6, 0.6)))
        face, cap = font(rng.choice(FONTS), px)
        left, top = int(4 + k * (W - 4) / LEN), int(H / LEN)
        layer = Image.new('L', (W, H), 0)
        ImageDraw.Draw(layer).text((left, top + cap), ch, font=face, fill=255, anchor='ls')
        layer = layer.rotate(rng.randint(-15, 15), resample=Image.BICUBIC, center=(left + rng.uniform(-1, 1), top + rng.uniform(-1, 1)))
        img.paste(Image.new('RGB', (W, H), tuple(int(rng.choice(COLORS)[i:i + 2], 16) for i in (1, 3, 5))), (0, 0), layer)
    draw = ImageDraw.Draw(img)
    for i in range(rng.choice([1, 1, 1, 1, 2])):
        draw.line((rng.randint(0, W) + i * rng.randint(0, H), rng.randint(0, H), rng.randint(0, W), rng.randint(0, H)),
                  fill=(255, 0, 255), width=rng.choice([1, 1, 1, 2]))
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=rng.choice([85, 90, 90, 95]))
    return text, Image.open(io.BytesIO(buf.getvalue())).convert('RGB')


class Pictures(IterableDataset):
    def __iter__(self):
        worker = torch.utils.data.get_worker_info()
        rng = random.Random((worker.id if worker else 0) * 1_000_003 + time.time_ns() % 1_000_000)
        while True:
            text, img = render(rng)
            yield torch.from_numpy(np.asarray(img, dtype=np.uint8).copy()).permute(2, 0, 1), torch.tensor([CHARS.index(c) for c in text])


def block(i, o):
    return nn.Sequential(nn.Conv2d(i, o, 3, padding=1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True),
                         nn.Conv2d(o, o, 3, padding=1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True))


class Net(nn.Module):
    """Four places of 62 characters from an RGB picture with values from 0 to 255."""
    def __init__(self):
        super().__init__()
        self.f = nn.Sequential(block(3, 32), nn.MaxPool2d(2), block(32, 64), nn.MaxPool2d(2),
                               block(64, 128), nn.MaxPool2d(2), block(128, 160), nn.MaxPool2d(2))
        self.fc = nn.Sequential(nn.Flatten(), nn.Dropout(0.3), nn.Linear(160 * 2 * 6, 256), nn.ReLU(inplace=True), nn.Dropout(0.2))
        self.heads = nn.Linear(256, LEN * len(CHARS))

    def forward(self, x):
        return self.heads(self.fc(self.f(x / 127.5 - 1.0))).view(-1, LEN, len(CHARS))


if __name__ == '__main__':
    steps, out = int(sys.argv[2]), sys.argv[3]
    device = torch.device('mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')
    net = Net().to(device)
    pictures = DataLoader(Pictures(), batch_size=256, num_workers=6, persistent_workers=True, prefetch_factor=4)
    optimizer = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=3e-3, total_steps=steps, pct_start=0.1)
    for step, (x, y) in enumerate(pictures):
        if step >= steps:
            break
        logits = net(x.to(device).float())
        loss = F.cross_entropy(logits.reshape(-1, len(CHARS)), y.to(device).reshape(-1), label_smoothing=0.05)
        optimizer.zero_grad(set_to_none=True); loss.backward(); optimizer.step(); schedule.step()
        if (step + 1) % 500 == 0:
            print(f'step {step + 1} loss {loss.item():.3f}', flush=True)
    net.cpu().eval()
    torch.onnx.export(net, torch.zeros(1, 3, H, W), out, input_names=['image'], output_names=['logits'], opset_version=17, dynamo=False)
