#!/usr/bin/env python3
"""Local page for checking and editing YOLO boxes in Po/dataset.

Each dataset is a folder under the work directory. Boxes are read from the
matching labels/*.txt file and saved back there. Other shapes are kept in a
LabelMe JSON file next to the image. Class names come from that dataset's
data.yaml (or data.yml), not from labels.txt. Label colors are saved in
labelme/.label-colors.json, one entry per opened data directory.

Work directory defaults to ../dataset. Pass --workdir to use another folder.
Run: python server.py --workdir ../dataset
Then open http://127.0.0.1:8765
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import struct
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
WORKDIR = (ROOT.parent / "dataset").resolve()
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff", ".gif"}
SHAPE_TYPES = {"polygon", "rectangle", "circle", "line", "point", "linestrip"}
MIN_POINTS = {
    "point": 1,
    "circle": 2,
    "line": 2,
    "rectangle": 2,
    "polygon": 3,
    "linestrip": 2,
}

mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("text/javascript", ".js")


def natural_key(text: str):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def inside(root: Path, full: Path) -> bool:
    root_s = os.path.normcase(str(root))
    full_s = os.path.normcase(str(full))
    return full_s == root_s or full_s.startswith(root_s + os.sep)


def resolve_under(rel: str) -> Path:
    rel = unquote(rel or "").replace("\\", "/").lstrip("/")
    if not rel or ":" in rel:
        raise ValueError("invalid path")
    parts = Path(rel).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("invalid path")
    full = (WORKDIR / rel).resolve()
    if not inside(WORKDIR.resolve(), full):
        raise ValueError("invalid path")
    return full


def image_file(rel: str) -> Path:
    path = resolve_under(rel)
    if path.suffix.lower() not in IMAGE_EXTS:
        raise ValueError("not an image")
    if not path.is_file():
        raise FileNotFoundError(rel)
    return path


def image_size(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image

        with Image.open(path) as im:
            width, height = im.size
            if width > 0 and height > 0:
                return int(width), int(height)
    except Exception:
        pass
    with path.open("rb") as handle:
        head = handle.read(32)
        if head.startswith(b"\x89PNG\r\n\x1a\n"):
            handle.seek(16)
            width, height = struct.unpack(">II", handle.read(8))
            return int(width), int(height)
        if head.startswith((b"GIF87a", b"GIF89a")):
            width, height = struct.unpack("<HH", head[6:10])
            return int(width), int(height)
        if head.startswith(b"BM") and len(head) >= 26:
            width, height = struct.unpack_from("<ii", head, 18)
            return abs(int(width)), abs(int(height))
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            return _webp_size(handle)
        if head[:2] == b"\xff\xd8":
            return _jpeg_size(handle)
    raise ValueError("cannot read image size")


def _jpeg_size(handle) -> tuple[int, int]:
    handle.seek(2)
    sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while True:
        marker = handle.read(1)
        if marker != b"\xff":
            break
        marker = handle.read(1)
        while marker == b"\xff":
            marker = handle.read(1)
        if not marker:
            break
        code = marker[0]
        if code in {0xD8, 0xD9}:
            break
        if code == 0x01 or 0xD0 <= code <= 0xD7:
            continue
        size_bytes = handle.read(2)
        if len(size_bytes) < 2:
            break
        size = struct.unpack(">H", size_bytes)[0]
        if size < 2:
            break
        if code in sof:
            handle.read(1)
            height, width = struct.unpack(">HH", handle.read(4))
            return int(width), int(height)
        if code == 0xDA:
            break
        handle.seek(size - 2, os.SEEK_CUR)
    raise ValueError("cannot read jpeg size")


def _webp_size(handle) -> tuple[int, int]:
    handle.seek(12)
    kind = handle.read(4)
    if kind == b"VP8X":
        handle.seek(24)
        raw = handle.read(6)
        width = 1 + int.from_bytes(raw[0:3], "little")
        height = 1 + int.from_bytes(raw[3:6], "little")
        return width, height
    if kind == b"VP8 ":
        handle.seek(26)
        width, height = struct.unpack("<HH", handle.read(4))
        return int(width & 0x3FFF), int(height & 0x3FFF)
    if kind == b"VP8L":
        handle.seek(21)
        bits = int.from_bytes(handle.read(4), "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    raise ValueError("cannot read webp size")


def yolo_label_path(image_path: Path) -> Path | None:
    try:
        rel = image_path.resolve().relative_to(WORKDIR.resolve())
    except ValueError:
        return None
    parts = list(rel.parts)
    if "images" not in parts:
        return None
    parts[parts.index("images")] = "labels"
    dest = WORKDIR.joinpath(*parts).with_suffix(".txt").resolve()
    if not inside(WORKDIR.resolve(), dest):
        return None
    return dest


def detach_hardlink(path: Path) -> None:
    if not path.is_file() or path.stat().st_nlink <= 1:
        return
    data = path.read_bytes()
    tmp = path.with_name(path.name + ".copy")
    tmp.write_bytes(data)
    tmp.replace(path)


def class_names_for(image_path: Path) -> list[str]:
    return yaml_class_names(dataset_of_image(image_path))


def clean_label(value) -> str:
    text = " ".join(str(value).replace("\x00", "").split())
    return text[:128]


def list_dataset_names() -> list[str]:
    WORKDIR.mkdir(parents=True, exist_ok=True)
    # This folder is itself one YOLO set (images/ next to labels/).
    if (WORKDIR / "images").is_dir():
        return []
    names = [
        child.name
        for child in WORKDIR.iterdir()
        if child.is_dir() and not child.name.startswith(".") and child.name not in {"images", "labels"}
    ]
    names.sort(key=natural_key)
    return names


def dataset_root(name: str) -> Path:
    names = list_dataset_names()
    if name not in names:
        raise ValueError("unknown dataset")
    path = (WORKDIR / name).resolve()
    if not inside(WORKDIR.resolve(), path) or path.parent != WORKDIR.resolve():
        raise ValueError("invalid dataset")
    return path


def choose_dataset(requested: str) -> str:
    names = list_dataset_names()
    if requested in names:
        return requested
    return names[0] if names else ""


def yaml_class_names(dataset: str) -> list[str]:
    root = dataset_root(dataset) if dataset else WORKDIR
    text = ""
    for name in ("data.yaml", "data.yml"):
        path = root / name
        if path.is_file():
            text = path.read_text(encoding="utf-8-sig")
            break
    if not text:
        return []
    inline = re.search(r"(?m)^names\s*:\s*\[([^\]]*)\]", text)
    found: list[str] = []
    if inline:
        for part in inline.group(1).split(","):
            label = clean_label(part.strip().strip("'\""))
            if label and label not in found:
                found.append(label)
        return found
    in_names = False
    for line in text.splitlines():
        stripped = line.strip()
        if not in_names:
            if re.match(r"^names\s*:\s*$", stripped):
                in_names = True
            continue
        if stripped and not line.startswith((" ", "\t")):
            break
        match = re.match(r"^\s*(?:-\s+|\d+\s*:\s*)(.+?)\s*$", line)
        if not match:
            continue
        label = clean_label(match.group(1).strip().strip("'\""))
        if label and label not in found:
            found.append(label)
    return found


LABEL_COLORS_NAME = ".label-colors.json"
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
_COLOR_LOCK = threading.Lock()


def labelme_color(index: int) -> str:
    """LabelMe auto color: imgviz colormap entry 1 + class index."""
    value = (1 + index) & 255
    red = green = blue = 0
    for shift in range(7, -1, -1):
        red |= (value & 1) << shift
        green |= ((value >> 1) & 1) << shift
        blue |= ((value >> 2) & 1) << shift
        value >>= 3
    return "#%02x%02x%02x" % (red, green, blue)


def colors_file() -> Path:
    return ROOT / LABEL_COLORS_NAME


def directory_key(dataset: str) -> str:
    root = dataset_root(dataset) if dataset else WORKDIR
    return str(root.resolve())


def sanitize_colors(data: dict) -> dict[str, str]:
    cleaned: dict[str, str] = {}
    for key, value in data.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        label = clean_label(key)
        if label and HEX_COLOR.fullmatch(value):
            cleaned[label] = value.lower()
        if len(cleaned) >= 500:
            break
    return cleaned


def load_color_book() -> dict[str, dict[str, str]]:
    path = colors_file()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    book: dict[str, dict[str, str]] = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, dict):
            book[key] = sanitize_colors(value)
    return book


def save_color_book(book: dict[str, dict[str, str]]) -> None:
    path = colors_file()
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(book, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def ensure_label_colors(dataset: str) -> dict[str, str]:
    """Remember this data directory's colors in labelme/.label-colors.json."""
    key = directory_key(dataset)
    with _COLOR_LOCK:
        book = load_color_book()
        colors = dict(book.get(key, {}))
        changed = key not in book
        for index, label in enumerate(load_dataset_labels(dataset)):
            if label not in colors:
                colors[label] = labelme_color(index)
                changed = True
        if changed and colors:
            book[key] = colors
            save_color_book(book)
        return colors


def save_label_colors(dataset: str, data: dict) -> dict[str, str]:
    incoming = sanitize_colors(data)
    key = directory_key(dataset)
    with _COLOR_LOCK:
        book = load_color_book()
        colors = dict(book.get(key, {}))
        colors.update(incoming)
        book[key] = colors
        save_color_book(book)
    return colors


def load_dataset_labels(dataset: str) -> list[str]:
    return yaml_class_names(dataset)


def remember_labels(_names: list[str], dataset: str) -> list[str]:
    return load_dataset_labels(dataset)


def dataset_of_image(image_path: Path) -> str:
    rel = image_path.resolve().relative_to(WORKDIR.resolve())
    if not rel.parts:
        return ""
    first = rel.parts[0]
    return first if first in set(list_dataset_names()) else ""


def _metric(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _manifest_scores(path: Path) -> dict[str, dict]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    rows = data.get("items") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return {}
    scores: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        image = row.get("image")
        score = _metric(row.get("score"))
        if not isinstance(image, str) or score is None:
            continue
        record = {"score": score}
        for name in ("map50", "false_positive"):
            metric = _metric(row.get(name))
            if metric is not None:
                record[name] = metric
        per_class = row.get("map50_per_class")
        if isinstance(per_class, list):
            values = [_metric(item) for item in per_class]
            if values and all(item is not None for item in values):
                record["map50_per_class"] = values
        key = image.replace("\\", "/").lstrip("./")
        scores[key] = record
        scores[Path(key).name] = record
    return scores


def miner_scores(root: Path) -> dict[str, dict]:
    """Challenge scores for this folder. A manifest without scores can use a sibling set."""
    scores: dict[str, float] = {}
    parent = root.parent
    if parent.is_dir():
        for child in sorted(parent.iterdir(), key=lambda item: item.name):
            if child.is_dir() and child.resolve() != root.resolve():
                scores.update(_manifest_scores(child / "manifest.json"))
        scores.update(_manifest_scores(parent / "manifest.json"))
    scores.update(_manifest_scores(root / "manifest.json"))
    return scores


def list_images(dataset: str) -> list[dict]:
    base = WORKDIR.resolve()
    root = dataset_root(dataset) if dataset else base
    root.mkdir(parents=True, exist_ok=True)
    scores = miner_scores(root)
    items: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted((name for name in dirnames if not name.startswith(".")), key=natural_key)
        for name in filenames:
            if name.startswith("."):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in IMAGE_EXTS:
                continue
            full = Path(dirpath) / name
            if "images" not in full.relative_to(root).parts:
                continue
            rel = full.relative_to(base).as_posix()
            parent = Path(rel).parent.as_posix()
            if dataset and (parent == dataset or parent.startswith(dataset + "/")):
                parent = parent[len(dataset) :].lstrip("/")
            yolo = yolo_label_path(full)
            labeled = (yolo is not None and yolo.is_file()) or full.with_suffix(".json").is_file()
            rel_root = full.relative_to(root).as_posix()
            info = scores.get(rel_root)
            if info is None:
                info = scores.get(name)
            entry = {
                "path": rel,
                "name": name,
                "dir": "" if parent in {"", "."} else parent,
                "labeled": labeled,
            }
            if info is not None:
                entry["score"] = info["score"]
                if "map50" in info:
                    entry["map50"] = info["map50"]
                if "false_positive" in info:
                    entry["false_positive"] = info["false_positive"]
                if "map50_per_class" in info:
                    entry["map50_per_class"] = info["map50_per_class"]
            items.append(entry)
    items.sort(key=lambda item: natural_key(item["path"]))
    return items


def empty_annotation(image_name: str) -> dict:
    return {
        "version": "5.5.0",
        "flags": {},
        "shapes": [],
        "imagePath": image_name,
        "imageData": None,
        "imageHeight": None,
        "imageWidth": None,
    }


def parse_yolo(path: Path, classes: list[str], width: int, height: int) -> list[dict]:
    shapes = []
    text = path.read_text(encoding="utf-8-sig")
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 5:
            continue
        try:
            class_id = int(float(parts[0]))
            cx, cy, box_w, box_h = (float(value) for value in parts[1:])
        except ValueError:
            continue
        if class_id < 0 or box_w <= 0 or box_h <= 0:
            continue
        label = classes[class_id] if class_id < len(classes) else "class_%s" % class_id
        x1 = (cx - box_w / 2) * width
        y1 = (cy - box_h / 2) * height
        x2 = (cx + box_w / 2) * width
        y2 = (cy + box_h / 2) * height
        shapes.append(
            {
                "label": label,
                "points": [[round(x1, 2), round(y1, 2)], [round(x2, 2), round(y2, 2)]],
                "group_id": None,
                "description": "",
                "shape_type": "rectangle",
                "flags": {"class_id": class_id},
                "mask": None,
            }
        )
    return shapes


def shapes_to_yolo(shapes: list[dict], classes: list[str], width: int, height: int) -> tuple[str, list[dict]]:
    names = {name: index for index, name in enumerate(classes)}
    lines: list[str] = []
    extra: list[dict] = []
    for shape in shapes:
        if shape.get("shape_type") != "rectangle":
            extra.append(shape)
            continue
        label = shape.get("label") or ""
        flags = shape.get("flags") if isinstance(shape.get("flags"), dict) else {}
        if label in names:
            class_id = names[label]
        else:
            try:
                class_id = int(flags.get("class_id"))
            except (TypeError, ValueError):
                extra.append(shape)
                continue
            if class_id < 0:
                extra.append(shape)
                continue
        points = shape.get("points") or []
        if len(points) < 2:
            continue
        try:
            x1, y1 = float(points[0][0]), float(points[0][1])
            x2, y2 = float(points[1][0]), float(points[1][1])
        except (TypeError, ValueError, IndexError):
            continue
        left, right = sorted((x1, x2))
        top, bottom = sorted((y1, y2))
        left = min(max(left, 0.0), float(width))
        right = min(max(right, 0.0), float(width))
        top = min(max(top, 0.0), float(height))
        bottom = min(max(bottom, 0.0), float(height))
        box_w = right - left
        box_h = bottom - top
        if box_w < 0.5 or box_h < 0.5:
            continue
        lines.append(
            "%d %.6f %.6f %.6f %.6f"
            % (
                class_id,
                ((left + right) / 2) / width,
                ((top + bottom) / 2) / height,
                box_w / width,
                box_h / height,
            )
        )
    return ("\n".join(lines) + ("\n" if lines else "")), extra


def read_labelme(path: Path) -> tuple[list[dict], str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return [], "Annotation file is not valid JSON. Saving will replace it."
    if not isinstance(data, dict):
        return [], "Annotation file is not a LabelMe object."
    shapes = data.get("shapes")
    if not isinstance(shapes, list):
        return [], ""
    return [shape for shape in shapes if isinstance(shape, dict)], ""


def read_annotation(image_path: Path) -> dict:
    payload = empty_annotation(image_path.name)
    payload["exists"] = False
    try:
        width, height = image_size(image_path)
    except (OSError, ValueError) as exc:
        payload["error"] = str(exc)
        return payload
    payload["imageWidth"] = width
    payload["imageHeight"] = height
    classes = class_names_for(image_path)
    known = set(classes)
    shapes: list[dict] = []
    yolo = yolo_label_path(image_path)
    yolo_loaded = bool(yolo and yolo.is_file())
    if yolo_loaded:
        shapes.extend(parse_yolo(yolo, classes, width, height))
        payload["exists"] = True
        payload["labelPath"] = yolo.resolve().relative_to(WORKDIR.resolve()).as_posix()
    sidecar = image_path.with_suffix(".json")
    if sidecar.is_file():
        extra, error = read_labelme(sidecar)
        if error:
            payload["error"] = error
        else:
            if yolo_loaded:
                extra = [
                    shape
                    for shape in extra
                    if shape.get("shape_type") != "rectangle" or shape.get("label") not in known
                ]
            shapes.extend(extra)
            payload["exists"] = True
    payload["shapes"] = shapes
    return payload


def write_yolo(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    detach_hardlink(path)
    tmp = path.with_suffix(".txt.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def store_annotation(image_path: Path, payload: dict) -> dict:
    classes = class_names_for(image_path)
    yolo = yolo_label_path(image_path)
    shapes = payload["shapes"]
    unstored: list[dict] = []
    if yolo is not None:
        text, unstored = shapes_to_yolo(shapes, classes, payload["imageWidth"], payload["imageHeight"])
        write_yolo(yolo, text)
        payload["labelPath"] = yolo.resolve().relative_to(WORKDIR.resolve()).as_posix()
    else:
        unstored = []
    sidecar = image_path.with_suffix(".json")
    sidecar_shapes = unstored if yolo is not None else shapes
    if sidecar_shapes:
        side = dict(payload)
        side["shapes"] = sidecar_shapes
        side.pop("exists", None)
        side.pop("unstored", None)
        side.pop("labelPath", None)
        side.pop("labels", None)
        write_annotation(image_path, side)
    elif sidecar.is_file() and yolo is not None:
        sidecar.unlink()
    elif yolo is None:
        write_annotation(image_path, payload)
    payload["exists"] = True
    payload["unstored"] = len(unstored) if yolo is not None else 0
    return payload


def sanitize_annotation(data: dict, image_path: Path) -> dict:
    if not isinstance(data, dict):
        raise ValueError("annotation must be an object")
    try:
        width = int(data.get("imageWidth"))
        height = int(data.get("imageHeight"))
    except (TypeError, ValueError):
        raise ValueError("imageWidth and imageHeight are required") from None
    if width <= 0 or height <= 0 or width > 100000 or height > 100000:
        raise ValueError("invalid image size")

    shapes = []
    for raw in data.get("shapes") or []:
        if not isinstance(raw, dict):
            continue
        shape_type = raw.get("shape_type")
        if shape_type not in SHAPE_TYPES:
            continue
        points = []
        for point in raw.get("points") or []:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            try:
                x = round(float(point[0]), 2)
                y = round(float(point[1]), 2)
            except (TypeError, ValueError):
                continue
            points.append([x, y])
        if shape_type in {"point", "circle", "line", "rectangle"}:
            points = points[: MIN_POINTS[shape_type]]
        if len(points) < MIN_POINTS[shape_type]:
            continue
        label = clean_label(raw.get("label")) or "object"
        group_id = raw.get("group_id")
        if group_id is not None and group_id != "":
            try:
                group_id = int(group_id)
            except (TypeError, ValueError):
                group_id = None
        else:
            group_id = None
        flags = raw.get("flags") if isinstance(raw.get("flags"), dict) else {}
        shapes.append(
            {
                "label": label,
                "points": points,
                "group_id": group_id,
                "description": str(raw.get("description") or "")[:500],
                "shape_type": shape_type,
                "flags": flags,
                "mask": None,
            }
        )

    return {
        "version": "5.5.0",
        "flags": {},
        "shapes": shapes,
        "imagePath": image_path.name,
        "imageData": None,
        "imageHeight": height,
        "imageWidth": width,
    }


def write_annotation(image_path: Path, payload: dict) -> None:
    target = image_path.with_suffix(".json")
    tmp = target.with_suffix(".json.tmp")
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(target)


class Handler(BaseHTTPRequestHandler):
    server_version = "Labelling/1.0"

    def log_message(self, fmt: str, *args) -> None:
        message = fmt % args
        if message.startswith('"GET /api/image'):
            return
        print("[%s] %s" % (self.log_date_time_string(), message))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)
        try:
            if path == "/api/state":
                dataset = choose_dataset(query.get("dataset", [""])[0])
                images = list_images(dataset)
                labeled = sum(1 for item in images if item["labeled"])
                folder = dataset_root(dataset) if dataset else WORKDIR
                self.send_json(
                    {
                        "workdir": str(folder),
                        "datasets": list_dataset_names(),
                        "dataset": dataset,
                        "labels": load_dataset_labels(dataset),
                        "colors": ensure_label_colors(dataset),
                        "images": images,
                        "labeled": labeled,
                        "total": len(images),
                    }
                )
                return
            if path == "/api/annotation":
                image = image_file(query.get("path", [""])[0])
                self.send_json(read_annotation(image))
                return
            if path == "/api/image":
                image = image_file(query.get("path", [""])[0])
                mime = mimetypes.guess_type(image.name)[0] or "application/octet-stream"
                data = image.read_bytes()
                self.send_bytes(data, mime)
                return
            if path in {"/", "/index.html"}:
                self.send_file(STATIC / "index.html", "text/html; charset=utf-8")
                return
            if path.startswith("/static/"):
                rel = path[len("/static/") :]
                file_path = (STATIC / rel).resolve()
                if not inside(STATIC.resolve(), file_path):
                    self.send_error_json(404, "not found")
                    return
                if not file_path.is_file():
                    self.send_error_json(404, "not found")
                    return
                mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
                if file_path.suffix in {".html", ".css", ".js"}:
                    mime += "; charset=utf-8"
                self.send_file(file_path, mime)
                return
            if path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            self.send_error_json(404, "not found")
        except FileNotFoundError:
            self.send_error_json(404, "file not found")
        except ValueError as exc:
            self.send_error_json(400, str(exc))
        except Exception as exc:  # noqa: BLE001 - last-resort API guard
            self.send_error_json(500, str(exc))

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            data = self.read_json()
            if parsed.path == "/api/labels":
                dataset = choose_dataset(query.get("dataset", [""])[0])
                self.send_json({"labels": load_dataset_labels(dataset), "dataset": dataset})
                return
            if parsed.path == "/api/colors":
                dataset = choose_dataset(query.get("dataset", [""])[0])
                raw = data.get("colors") if isinstance(data, dict) else None
                if not isinstance(raw, dict):
                    raise ValueError("colors must be an object")
                colors = save_label_colors(dataset, raw)
                self.send_json({"colors": colors, "dataset": dataset})
                return
            if parsed.path == "/api/annotation":
                image = image_file(query.get("path", [""])[0])
                payload = sanitize_annotation(data, image)
                payload = store_annotation(image, payload)
                labels = remember_labels([shape["label"] for shape in payload["shapes"]], dataset_of_image(image))
                payload["labels"] = labels
                self.send_json(payload)
                return
            self.send_error_json(404, "not found")
        except FileNotFoundError:
            self.send_error_json(404, "file not found")
        except ValueError as exc:
            self.send_error_json(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            self.send_error_json(500, str(exc))

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path != "/api/annotation":
                self.send_error_json(404, "not found")
                return
            image = image_file(query.get("path", [""])[0])
            yolo = yolo_label_path(image)
            if yolo is not None:
                write_yolo(yolo, "")
            ann = image.with_suffix(".json")
            if ann.is_file():
                ann.unlink()
            self.send_json({"ok": True, "exists": yolo is not None and yolo.is_file()})
        except FileNotFoundError:
            self.send_error_json(404, "file not found")
        except ValueError as exc:
            self.send_error_json(400, str(exc))

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 20_000_000:
            raise ValueError("body is too large")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8-sig"))
        except json.JSONDecodeError as exc:
            raise ValueError("invalid JSON") from exc

    def send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_bytes(body, "application/json; charset=utf-8", status)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"error": message}, status)

    def send_file(self, path: Path, content_type: str) -> None:
        self.send_bytes(path.read_bytes(), content_type)

    def send_bytes(self, data: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    global WORKDIR
    parser = argparse.ArgumentParser(description="Check and edit YOLO labels in the dataset folder.")
    parser.add_argument("--workdir", type=Path, default=ROOT.parent / "dataset", help="Folder that contains the datasets")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    WORKDIR = args.workdir.expanduser().resolve()
    WORKDIR.mkdir(parents=True, exist_ok=True)
    if list_dataset_names():
        for name in list_dataset_names():
            ensure_label_colors(name)
    else:
        ensure_label_colors("")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    shown = "127.0.0.1" if args.host in {"0.0.0.0", "::"} else args.host
    url = "http://%s:%s/" % (shown, args.port)
    print("Labelling", flush=True)
    print("  work dir: %s" % WORKDIR, flush=True)
    print("  open:     %s" % url, flush=True)
    if not args.no_browser:
        def _open() -> None:
            try:
                webbrowser.open(url)
            except Exception:
                pass

        threading.Timer(0.4, _open).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
