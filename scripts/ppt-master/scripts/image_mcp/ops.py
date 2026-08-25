"""图片处理操作：信息、格式转换、缩放、压缩、旋转、裁切、水印。

全部基于 Pillow（已嵌入运行时），无新增依赖。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps

from .cjk_fonts import find_cjk_font

# 扩展名 → Pillow 保存格式（对齐 image_backends/backend_common.EXT_TO_PIL_FORMAT）
EXT_TO_FORMAT = {
    ".png": "PNG",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".webp": "WEBP",
    ".gif": "GIF",
    ".bmp": "BMP",
    ".tif": "TIFF",
    ".tiff": "TIFF",
    ".ico": "ICO",
}

POSITIONS = ("top-left", "top-right", "bottom-left", "bottom-right", "center", "tile")


def _resolve_path(p: str) -> Path:
    return Path(p).expanduser().resolve()


def _open(path: Path) -> Image.Image:
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {path}")
    return Image.open(path)


def image_info(imagePath: str) -> dict[str, Any]:
    """读取图片尺寸/格式/模式/大小/EXIF。"""
    p = _resolve_path(imagePath)
    img = _open(p)
    try:
        info: dict[str, Any] = {
            "format": img.format,
            "mode": img.mode,
            "width": img.width,
            "height": img.height,
            "fileSize": p.stat().st_size,
            "colorSpace": img.mode,
        }
        try:
            exif = img.getexif()
            info["hasExif"] = 274 in exif  # 274 = Orientation
            if 274 in exif:
                info["exifOrientation"] = exif[274]
        except Exception:
            info["hasExif"] = False
        return info
    finally:
        img.close()


def _target_format(output_path: Path, fallback: str | None) -> str:
    return EXT_TO_FORMAT.get(output_path.suffix.lower(), fallback or "PNG")


def image_convert(
    imagePath: str,
    outputPath: str,
    quality: int = 90,
    stripMetadata: bool = False,
) -> dict[str, Any]:
    """格式转换：目标格式由 outputPath 扩展名决定，JPEG 自动转 RGB。"""
    p = _resolve_path(imagePath)
    out = _resolve_path(outputPath)
    out.parent.mkdir(parents=True, exist_ok=True)

    src_img = _open(p)
    try:
        target = _target_format(out, src_img.format)
        if target in ("JPEG",) and src_img.mode not in ("RGB", "L"):
            img = src_img.convert("RGB")
        else:
            img = src_img

        save_kwargs: dict[str, Any] = {}
        if target in ("JPEG", "WEBP"):
            save_kwargs["quality"] = int(quality)
        if stripMetadata:
            img = img.copy()  # 不携带 exif/icc 即剥离
        else:
            if src_img.info.get("icc_profile"):
                save_kwargs["icc_profile"] = src_img.info["icc_profile"]
            if src_img.info.get("exif"):
                save_kwargs["exif"] = src_img.info["exif"]
        img.save(out, format=target, **save_kwargs)
        return {"outputPath": str(out), "fileSize": out.stat().st_size, "format": target}
    finally:
        src_img.close()


def image_resize(
    imagePath: str,
    outputPath: str,
    width: int | None = None,
    height: int | None = None,
    mode: str = "fit",
    keepAspect: bool = True,
    background: str = "#FFFFFF",
) -> dict[str, Any]:
    """缩放。mode: fit（等比放入）/ fill（填满居中裁切）/ pad（等比+画布补白）/ stretch（拉伸）。"""
    if not width and not height:
        raise ValueError("width or height required")

    p = _resolve_path(imagePath)
    out = _resolve_path(outputPath)
    out.parent.mkdir(parents=True, exist_ok=True)

    src_img = _open(p)
    try:
        src_w, src_h = src_img.size
        mode = mode or "fit"

        if mode == "stretch" or not keepAspect:
            new_size = (width or src_w, height or src_h)
            result = src_img.resize(new_size, Image.LANCZOS)
        elif mode == "fill":
            ratio = max((width or src_w) / src_w, (height or src_h) / src_h)
            resized = src_img.resize((max(1, int(src_w * ratio)), max(1, int(src_h * ratio))), Image.LANCZOS)
            left = (resized.width - (width or resized.width)) // 2
            top = (resized.height - (height or resized.height)) // 2
            right = left + (width or resized.width)
            bottom = top + (height or resized.height)
            result = resized.crop((left, top, right, bottom))
        else:  # fit / pad
            target_w, target_h = width or src_w, height or src_h
            ratio = min(target_w / src_w, target_h / src_h)
            new_size = (max(1, int(src_w * ratio)), max(1, int(src_h * ratio)))
            resized = src_img.resize(new_size, Image.LANCZOS)
            if mode == "pad":
                canvas = Image.new("RGB", (target_w, target_h), _hex_to_rgb(background))
                canvas.paste(resized, ((target_w - new_size[0]) // 2, (target_h - new_size[1]) // 2))
                result = canvas
            else:
                result = resized

        result.save(out)
        return {"outputPath": str(out), "width": result.width, "height": result.height, "fileSize": out.stat().st_size}
    finally:
        src_img.close()


def image_compress(
    imagePath: str,
    outputPath: str,
    quality: int = 75,
    maxWidth: int | None = None,
    maxHeight: int | None = None,
    format: str | None = None,
) -> dict[str, Any]:
    """压缩图片（JPEG/WEBP 质量 + 可选最大尺寸限制）。"""
    p = _resolve_path(imagePath)
    out = _resolve_path(outputPath)
    out.parent.mkdir(parents=True, exist_ok=True)
    input_size = p.stat().st_size

    src_img = _open(p)
    try:
        img = src_img
        if maxWidth or maxHeight:
            ratio = 1.0
            if maxWidth:
                ratio = min(ratio, maxWidth / img.width)
            if maxHeight:
                ratio = min(ratio, maxHeight / img.height)
            if ratio < 1.0:
                img = src_img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))), Image.LANCZOS)

        target = (format or "").upper()
        if target == "JPG":
            target = "JPEG"
        if not target:
            target = img.format or "JPEG"
        if target == "JPEG" and img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        img.save(out, format=target, quality=int(quality), optimize=True)
        output_size = out.stat().st_size
        return {
            "outputPath": str(out),
            "inputSize": input_size,
            "outputSize": output_size,
            "ratio": round(output_size / input_size, 3) if input_size else 1.0,
            "format": target,
            "width": img.width,
            "height": img.height,
        }
    finally:
        src_img.close()


def image_rotate(
    imagePath: str,
    outputPath: str,
    degrees: float = 0,
    expand: bool = True,
    fixExif: bool = False,
) -> dict[str, Any]:
    """先做 EXIF 方向矫正（可选），再按 degrees 旋转；degrees 缺省为 0（仅矫正）。"""
    p = _resolve_path(imagePath)
    out = _resolve_path(outputPath)
    out.parent.mkdir(parents=True, exist_ok=True)

    img = _open(p)
    try:
        if fixExif:
            img = ImageOps.exif_transpose(img)
        rotated = img.rotate(float(degrees), expand=expand, resample=Image.BICUBIC)
        rotated.save(out)
        return {"outputPath": str(out), "width": rotated.width, "height": rotated.height}
    finally:
        img.close()


def image_crop(
    imagePath: str,
    outputPath: str,
    left: int,
    top: int,
    right: int,
    bottom: int,
) -> dict[str, Any]:
    """按像素坐标裁切（左/上/右/下）。"""
    p = _resolve_path(imagePath)
    out = _resolve_path(outputPath)
    out.parent.mkdir(parents=True, exist_ok=True)

    img = _open(p)
    try:
        cropped = img.crop((int(left), int(top), int(right), int(bottom)))
        cropped.save(out)
        return {"outputPath": str(out), "width": cropped.width, "height": cropped.height}
    finally:
        img.close()


def image_watermark(
    imagePath: str,
    outputPath: str,
    text: str | None = None,
    textImage: str | None = None,
    position: str = "bottom-right",
    opacity: float = 0.3,
    fontSize: int = 32,
    color: str = "#FFFFFF",
    margin: int = 16,
    fontPath: str | None = None,
) -> dict[str, Any]:
    """给图片加文字水印或图片水印。position 支持 tile 平铺。"""
    if not text and not textImage:
        raise ValueError("Either text or textImage is required")

    p = _resolve_path(imagePath)
    out = _resolve_path(outputPath)
    out.parent.mkdir(parents=True, exist_ok=True)

    img = _open(p)
    try:
        base = img.convert("RGBA")
        overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))

        if text:
            font = None
            if fontPath:
                font = ImageFont.truetype(fontPath, int(fontSize))
            else:
                candidate = find_cjk_font()
                if candidate:
                    try:
                        font = ImageFont.truetype(candidate, int(fontSize))
                    except Exception:
                        font = None
            if font is None:
                font = ImageFont.load_default()
            draw = ImageDraw.Draw(overlay)
            bbox = draw.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            fill = (*_hex_to_rgb(color), int(255 * opacity))

            if position == "tile":
                step_x = tw + max(80, tw)
                step_y = th + max(40, th)
                y = 0
                while y < base.height:
                    x = 0
                    while x < base.width:
                        draw.text((x, y), text, font=font, fill=fill)
                        x += step_x
                    y += step_y
            else:
                x, y = _anchor(base.size, (tw, th), position, margin)
                draw.text((x, y), text, font=font, fill=fill)
        else:
            wm = _open(_resolve_path(textImage or "")).convert("RGBA")
            # 等比缩放到主图 1/4
            scale = 0.25
            wm = wm.resize((max(1, int(wm.width * scale)), max(1, int(wm.height * scale))), Image.LANCZOS)
            x, y = _anchor(base.size, wm.size, position, margin)
            overlay.paste(wm, (x, y), wm)

        composed = Image.alpha_composite(base, overlay)
        if composed.mode == "RGBA":
            composed = composed.convert("RGB")
        composed.save(out)
        return {"outputPath": str(out)}
    finally:
        img.close()


def _anchor(canvas_size: tuple[int, int], item_size: tuple[int, int], position: str, margin: int) -> tuple[int, int]:
    """计算水印锚点坐标。"""
    cw, ch = canvas_size
    iw, ih = item_size
    margin = max(0, int(margin))
    mapping = {
        "top-left": (margin, margin),
        "top-right": (cw - iw - margin, margin),
        "bottom-left": (margin, ch - ih - margin),
        "bottom-right": (cw - iw - margin, ch - ih - margin),
        "center": ((cw - iw) // 2, (ch - ih) // 2),
    }
    return mapping.get(position, mapping["bottom-right"])


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    """#RGB / #RRGGBB → (r, g, b)；非法值回退白色。"""
    try:
        h = hex_color.lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 6:
            return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except Exception:
        pass
    return 255, 255, 255
