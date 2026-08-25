"""PDF encrypt/decrypt via PyMuPDF (fitz).

仅用于 pdf-lib 不支持的加密/解密写操作；合并/拆分/压缩/提取走纯 JS pdf-lib。
"""

from __future__ import annotations

import os
import secrets
import tempfile
from pathlib import Path
from typing import Any

# 用 pymupdf 官方新命名空间导入（fitz 别名会向 stdout 打印弃用警告，
# 污染单行 JSON 输出协议）；pymupdf 与 fitz 是同一库的两个入口。
import pymupdf as fitz  # noqa: E402


def _save_with_tmp(doc: Any, out: Path, **save_kwargs: Any) -> None:
    """先写临时文件，关闭 doc 后再原子替换目标文件。

    PyMuPDF 禁止非增量保存覆盖正在打开的原文件；Windows 上 os.replace
    目标文件被占用也会失败。因此先保存到临时文件、关闭 doc、再替换。
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out.parent, prefix=".pdf_ops_", suffix=".pdf")
    os.close(fd)
    try:
        doc.save(tmp, **save_kwargs)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    # 先关闭 doc 再替换，避免 Windows 文件锁定与 PyMuPDF 重复 close 报错
    try:
        doc.close()
    except Exception:
        pass
    os.replace(tmp, out)


def _encode_permissions(permissions: dict[str, bool] | None) -> int:
    """把权限 dict 编码为 PyMuPDF 权限位掩码。

    与 PDF 标准一致，默认禁止所有权限（值 0）。传入的 True 项按位开启。
    """
    p = permissions or {}
    perm_value = 0
    mapping = {
        "printing": fitz.PDF_PERM_PRINT,
        "modifying": fitz.PDF_PERM_MODIFY,
        "copying": fitz.PDF_PERM_COPY,
        "annotating": fitz.PDF_PERM_ANNOTATE,
        "fillingForms": fitz.PDF_PERM_FORM,
        "contentAccessibility": fitz.PDF_PERM_ACCESSIBILITY,
        "documentAssembly": fitz.PDF_PERM_ASSEMBLE,
    }
    for name, mask in mapping.items():
        if p.get(name):
            perm_value |= mask
    return perm_value


def encrypt_pdf(
    pdfPath: str,
    outputPath: str | None = None,
    userPassword: str | None = None,
    ownerPassword: str | None = None,
    permissions: dict[str, bool] | None = None,
) -> dict[str, Any]:
    """给 PDF 设置用户/所有者密码与权限，写出加密文件。

    参数名使用 camelCase，与 MCP 工具 schema 及 TS 层透传保持一致。
    """
    src = Path(pdfPath).expanduser().resolve()
    if not src.exists():
        raise FileNotFoundError(f"PDF not found: {src}")

    out = Path(outputPath).expanduser().resolve() if outputPath else src
    out.parent.mkdir(parents=True, exist_ok=True)

    # 仅加密时不希望用户/所有者密码都为空（pdf-lib 场景），给出安全默认
    owner = ownerPassword or secrets.token_urlsafe(24)
    user = userPassword or ""

    save_kwargs: dict[str, Any] = {
        "encryption": fitz.PDF_ENCRYPT_AES_256,
        "user_pw": user,
        "owner_pw": owner,
        "permissions": _encode_permissions(permissions),
    }

    doc = fitz.open(src)
    try:
        _save_with_tmp(doc, out, **save_kwargs)
    finally:
        try:
            doc.close()
        except Exception:
            pass

    return {"outputPath": str(out), "permissions": permissions or {}}


def decrypt_pdf(
    pdfPath: str,
    password: str,
    outputPath: str | None = None,
) -> dict[str, Any]:
    """解密 PDF（需密码），写出明文文件。"""
    src = Path(pdfPath).expanduser().resolve()
    if not src.exists():
        raise FileNotFoundError(f"PDF not found: {src}")

    out = Path(outputPath).expanduser().resolve() if outputPath else src
    out.parent.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(src)
    try:
        if doc.is_encrypted and not doc.authenticate(password):
            raise ValueError("Invalid password: could not decrypt PDF")
        _save_with_tmp(doc, out, encryption=fitz.PDF_ENCRYPT_NONE)
    finally:
        try:
            doc.close()
        except Exception:
            pass

    return {"outputPath": str(out)}
