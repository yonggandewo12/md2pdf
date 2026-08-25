"""跨平台 CJK 字体候选列表（图片文字水印用）。

必须与 src/pdf-postprocess.ts 的 CHINESE_FONT_CANDIDATES 保持同步更新。
"""

from __future__ import annotations

import os

CJK_FONT_CANDIDATES = [
    # macOS
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    # Linux
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    # Windows
    "C:\\Windows\\Fonts\\msyh.ttc",
    "C:\\Windows\\Fonts\\simsun.ttc",
    "C:\\Windows\\Fonts\\simhei.ttf",
]


def find_cjk_font() -> str | None:
    """返回第一个存在的 CJK 字体路径；找不到返回 None。"""
    for fp in CJK_FONT_CANDIDATES:
        if os.path.exists(fp):
            return fp
    return None
