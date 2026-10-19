"""Reading a chain's source: a video file, a folder of pictures, or a zip of them. Frames come out as RGBA
numpy arrays (a source without transparency has alpha 255 everywhere)."""

import os
import re
import subprocess
import zipfile

import numpy as np
from PIL import Image

PICTURES = (".png", ".webp", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff")
VIDEOS = (".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".gif")
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def natural_key(name):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)]


def probe(path):
    """What ffmpeg says of a video: {width, height, fps, duration, frames, codec, alpha}."""
    done = subprocess.run([ffmpeg(), "-hide_banner", "-nostdin", "-i", path], capture_output=True,
                          stdin=subprocess.DEVNULL, creationflags=_NO_WINDOW)
    said = done.stderr.decode("utf8", "replace")
    video = re.search(r"Stream #\S+.*?Video: (\w+)([^\n]*)", said)
    if not video:
        raise ValueError("ffmpeg finds no video in this file")
    codec, rest = video.group(1), video.group(2)
    size = re.search(r"(\d{2,5})x(\d{2,5})", rest)
    fps = re.search(r"([\d.]+) fps", rest) or re.search(r"([\d.]+) tbr", rest)
    duration = re.search(r"Duration: (\d+):(\d+):([\d.]+)", said)
    seconds = int(duration.group(1)) * 3600 + int(duration.group(2)) * 60 + float(duration.group(3)) if duration else 0.0
    rate = float(fps.group(1)) if fps else 25.0
    alpha = bool(re.search(r"alpha_mode\s*:\s*1", said)) or any(k in rest for k in ("yuva", "rgba", "argb", "bgra", "pal8")) \
        or codec in ("qtrle", "png") or (codec == "prores" and "4444" in rest)
    return {"width": int(size.group(1)) if size else 0, "height": int(size.group(2)) if size else 0,
            "fps": rate, "duration": seconds, "frames": int(round(seconds * rate)), "codec": codec, "alpha": alpha}


def read_video(path, start=0.0, end=None, fps=None, max_side=1280):
    """The frames of a video, one RGBA array at a time. `fps`: take that many frames a second (None: all of
    them); `max_side`: frames larger than this are made smaller first (the cut does not need more)."""
    info = probe(path)
    width, height = info["width"], info["height"]
    scale = min(1.0, float(max_side) / max(width, height)) if max_side else 1.0
    out_w, out_h = max(2, int(round(width * scale / 2)) * 2), max(2, int(round(height * scale / 2)) * 2)
    filters = []
    if fps:
        filters.append(f"fps={float(fps):.6f}")
    if (out_w, out_h) != (width, height):
        filters.append(f"scale={out_w}:{out_h}:flags=area")
    command = [ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error"]
    if info["codec"] in ("vp9", "vp8") and info["alpha"]:
        command += ["-c:v", "libvpx-vp9" if info["codec"] == "vp9" else "libvpx"]       # the decoder that keeps alpha
    if start:
        command += ["-ss", f"{float(start):.3f}"]
    command += ["-i", path]
    if end:
        command += ["-t", f"{max(0.04, float(end) - float(start or 0)):.3f}"]
    if filters:
        command += ["-vf", ",".join(filters)]
    command += ["-an", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                               creationflags=_NO_WINDOW)
    size = out_w * out_h * 4
    try:
        while True:
            data = process.stdout.read(size)
            if len(data) < size:
                break
            yield np.frombuffer(data, np.uint8).reshape(out_h, out_w, 4)
    finally:
        process.stdout.close()
        process.kill()
        process.wait()
        process.stderr.close()


def count_video(path, start=0.0, end=None, fps=None):
    info = probe(path)
    length = (min(float(end), info["duration"]) if end else info["duration"]) - float(start or 0)
    return max(1, int(round(max(0.0, length) * float(fps or info["fps"]))))


def list_pictures(folder):
    names = [n for n in os.listdir(folder) if n.lower().endswith(PICTURES)]
    return [os.path.join(folder, n) for n in sorted(names, key=natural_key)]


def unpack_zip(path, folder):
    """The pictures of a zip, in the order of their names, put into `folder`; nothing outside it is written."""
    os.makedirs(folder, exist_ok=True)
    written = []
    with zipfile.ZipFile(path) as packed:
        for member in packed.infolist():
            name = os.path.basename(member.filename)
            if member.is_dir() or not name.lower().endswith(PICTURES) or name.startswith("."):
                continue
            target = os.path.join(folder, f"{len(written):06d}_{re.sub(r'[^A-Za-z0-9._-]', '_', name)}")
            with packed.open(member) as source, open(target, "wb") as out:
                out.write(source.read())
            written.append((name, target))
    written.sort(key=lambda pair: natural_key(pair[0]))
    return [t for _n, t in written]


def read_picture(path, max_side=1280):
    image = Image.open(path)
    image.load()
    image = image.convert("RGBA")
    if max_side and max(image.size) > max_side:
        scale = float(max_side) / max(image.size)
        image = image.resize((max(2, round(image.size[0] * scale)), max(2, round(image.size[1] * scale))), Image.LANCZOS)
    return np.asarray(image)


def read_pictures(paths, max_side=1280):
    for path in paths:
        yield read_picture(path, max_side)
