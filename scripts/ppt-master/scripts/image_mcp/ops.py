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


def image_gif(
    imagePaths: list[str],
    outputPath: str,
    duration: int = 500,
    loop: int = 0,
) -> dict[str, Any]:
    """多帧图片合成 GIF 动图。duration 为每帧毫秒，loop 0 表示无限循环。"""
    if not imagePaths or not isinstance(imagePaths, list):
        raise ValueError("imagePaths must be a non-empty list")

    out = _resolve_path(outputPath)
    out.parent.mkdir(parents=True, exist_ok=True)

    frames: list[Image.Image] = []
    opened: list[Image.Image] = []
    try:
        for p in imagePaths:
            img = _open(_resolve_path(p)).convert("RGBA")
            opened.append(img)
            # 网络编码统一转 P 模式（GIF 调色板），透明色映射到索引 255
            alpha = img.getchannel("A")
            frame = img.convert("RGB").convert(
                "P", palette=Image.Palette.ADAPTIVE, colors=255
            )
            frame.paste(255, mask=alpha.point(lambda a: 255 if a < 128 else 0))
            frames.append(frame)
        frames[0].save(
            out,
            format="GIF",
            save_all=True,
            append_images=frames[1:],
            duration=int(duration),
            loop=int(loop),
            transparency=255,
            disposal=2,
        )
    finally:
        for img in opened:
            img.close()

    return {
        "outputPath": str(out),
        "frames": len(frames),
        "fileSize": out.stat().st_size,
    }


def image_quantize(
    imagePath: str,
    outputPath: str,
    colors: int = 256,
    method: str | None = None,
) -> dict[str, Any]:
    """颜色量化（减少调色板颜色数）。method: mediancut/maxcoverage/fastoctree/libimagequant。"""
    p = _resolve_path(imagePath)
    out = _resolve_path(outputPath)
    out.parent.mkdir(parents=True, exist_ok=True)
    input_size = p.stat().st_size

    method_map = {
        "mediancut": Image.Quantize.MEDIANCUT,
        "maxcoverage": Image.Quantize.MAXCOVERAGE,
        "fastoctree": Image.Quantize.FASTOCTREE,
        "libimagequant": Image.Quantize.LIBIMAGEQUANT,
    }
    kwargs: dict[str, Any] = {"colors": max(2, min(int(colors), 256))}
    if method:
        if method not in method_map:
            raise ValueError(f"Unknown quantize method: {method} (available: {sorted(method_map)})")
        kwargs["method"] = method_map[method]

    img = _open(p)
    try:
        src_mode = img.mode
        has_alpha = src_mode in ("RGBA", "LA") or (src_mode == "P" and "transparency" in img.info)
        # Pillow 限制：MEDIANCUT/MAXCOVERAGE 不接受 RGBA 输入。这两种方法下
        # 透明区域先合成到白底再转 RGB；其余方法（含默认自动选择）保留 RGBA。
        method_id = kwargs.get("method")
        if method_id in (Image.Quantize.MEDIANCUT, Image.Quantize.MAXCOVERAGE):
            if has_alpha:
                rgba = img.convert("RGBA")
                base = Image.new("RGB", rgba.size, (255, 255, 255))
                base.paste(rgba, mask=rgba.getchannel("A"))
            else:
                base = img.convert("RGB")
        else:
            base = img.convert("RGBA")
        quantized = base.quantize(**kwargs)
        target = _target_format(out, "PNG")
        # 目标格式不接受调色板时先转回 RGB
        if target == "JPEG":
            quantized = quantized.convert("RGB")
        quantized.save(out, format=target)
        output_size = out.stat().st_size
        return {
            "outputPath": str(out),
            "colors": kwargs["colors"],
            "mode": f"{src_mode} → P",
            "inputSize": input_size,
            "outputSize": output_size,
            "ratio": round(output_size / input_size, 3) if input_size else 1.0,
        }
    finally:
        img.close()


# IFD0 级常用 EXIF 标签名 → tag id（写入用；其余 tag 直接用数字）
# 键统一小写：查找方先对用户输入 key.lower()，两处大小写必须一致
_EXIF_TAG_NAMES = {
    "imagedescription": 270,
    "make": 271,
    "model": 272,
    "orientation": 274,
    "software": 305,
    "datetime": 306,
    "artist": 315,
    "copyright": 33432,
}


def image_edit_exif(
    imagePath: str,
    outputPath: str,
    exif: dict[str, Any] | None = None,
    strip: bool = False,
) -> dict[str, Any]:
    """读取/编辑/剥离 EXIF。

    - 不传 exif 且不传 strip：读取当前 EXIF（含 Exif IFD）；
    - exif：写入字段。键为 tag 名（make/model/orientation/dateTime/artist/
      copyright/software/imageDescription）或数字字符串，值为 str/int/float；
    - strip：移除全部 EXIF。
    """
    p = _resolve_path(imagePath)
    out = _resolve_path(outputPath)
    out.parent.mkdir(parents=True, exist_ok=True)

    img = _open(p)
    try:
        if not exif and not strip:
            # 读取模式
            exif_obj = img.getexif()
            result: dict[str, Any] = {}
            for tag_id, value in exif_obj.items():
                result[str(tag_id)] = value if isinstance(value, (str, int, float)) else str(value)
            exif_ifd = exif_obj.get_ifd(0x8769)
            for tag_id, value in exif_ifd.items():
                result[f"exif:{tag_id}"] = value if isinstance(value, (str, int, float)) else str(value)
            return {"exif": result, "count": len(result)}

        target = _target_format(out, img.format or "JPEG")
        if target == "PNG":
            raise ValueError("PNG 不支持 EXIF 写入，请保存为 JPEG/TIFF/WebP")

        if strip:
            # 不携带 exif 即剥离
            plain = img.copy()
            plain.save(out, format=target)
            return {"outputPath": str(out), "stripped": True}

        exif_obj = img.getexif()
        written = 0
        for key, value in (exif or {}).items():
            tag_id: int | None
            if isinstance(key, str) and key.lower() in _EXIF_TAG_NAMES:
                tag_id = _EXIF_TAG_NAMES[key.lower()]
            else:
                try:
                    tag_id = int(key)
                except (TypeError, ValueError):
                    raise ValueError(f"未知 EXIF tag: {key}")
            if isinstance(value, (dict, list)):
                raise ValueError(f"EXIF 值不支持嵌套类型: {key}")
            if isinstance(value, str) and any(ord(c) > 0xFF for c in value):
                # EXIF ASCII 类型仅 Latin-1；Pillow 会静默替换为 '?' 造成数据损坏
                raise ValueError(f"EXIF 值含非 Latin-1 字符（中文等请改用数字 tag 或先转写）: {key}")
            exif_obj[tag_id] = value
            written += 1
        img.save(out, format=target, exif=exif_obj.tobytes())
        return {"outputPath": str(out), "written": written}
    finally:
        img.close()
