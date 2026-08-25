#!/usr/bin/env python3
"""PPTX 读取/编辑 MCP 统一入口脚本。

被 src/ppt-service.ts 通过子进程调用。协议与 scripts/excel/run.py 一致：
  python run.py --action <name> --params '<json>'
  python run.py --list          # 列出所有 action
  python run.py --check         # 自检依赖
  python run.py --action <name> # params 从 stdin 读 JSON

输出（stdout）固定为单行 JSON：
  成功: {"success": true, "data": <result>}
  失败: {"success": false, "error": "...", "code": "...", "error_type": "..."}

日志走 stderr，不污染 stdout。
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import traceback
from pathlib import Path
from typing import Any, Callable

# 本脚本位于 scripts/ppt-master/scripts/ppt_mcp/ 下；把 scripts/ 目录
# 加入 sys.path，便于复用同级脚本库（pptx_to_svg、template_fill_pptx、
# source_to_md 等）。
_HERE = Path(__file__).resolve().parent
_SCRIPTS_DIR = _HERE.parent
for _p in (_HERE, _SCRIPTS_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from console_encoding import configure_utf8_stdio  # noqa: E402
from ppt_mcp import reader, writer  # noqa: E402

configure_utf8_stdio()

logger = logging.getLogger("ppt_mcp.run")

ACTIONS: dict[str, Callable[..., Any]] = {
    # 读
    "read_presentation": reader.read_presentation,
    "read_slide_details": reader.read_slide_details,
    "extract_text": reader.extract_text,
    "to_images": reader.to_images,
    # 写
    "apply_plan": writer.apply_plan,
    "replace_text": writer.replace_text,
    "replace_table_cells": writer.replace_table_cells,
    "duplicate_slide": writer.duplicate_slide,
    "add_notes": writer.add_notes,
    "set_transitions": writer.set_transitions,
}


def _emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, default=str, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _ok(result: Any) -> None:
    if isinstance(result, str):
        _emit({"success": True, "data": {"message": result}})
    else:
        _emit({"success": True, "data": result})


def _fail(err: BaseException) -> None:
    _emit({"success": False, "error": str(err), "code": "PPTX_ERROR", "error_type": err.__class__.__name__})


def _load_params(args: argparse.Namespace) -> dict[str, Any]:
    if args.params is not None:
        if args.params.strip() == "":
            return {}
        return json.loads(args.params)
    if not sys.stdin.isatty():
        raw = sys.stdin.read().strip()
        if raw:
            return json.loads(raw)
    return {}


def _check_deps() -> dict[str, Any]:
    import pptx
    import pymupdf
    import template_fill_pptx
    return {
        "python-pptx": pptx.__version__,
        "PyMuPDF": getattr(pymupdf, "__version__", "ok"),
        "template_fill_pptx": "ok",
    }


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s", stream=sys.stderr)
    parser = argparse.ArgumentParser(description="PPTX MCP entry")
    parser.add_argument("--action", help="action name")
    parser.add_argument("--params", help="JSON params (default: read from stdin)")
    parser.add_argument("--list", action="store_true", help="list all actions")
    parser.add_argument("--check", action="store_true", help="self-check dependencies")
    args = parser.parse_args()

    if args.list:
        _emit({"success": True, "data": {"actions": sorted(ACTIONS.keys())}})
        return 0

    if args.check:
        try:
            _emit({"success": True, "data": _check_deps()})
            return 0
        except Exception as e:
            _emit({"success": False, "error": f"PPTX deps not available: {e}", "code": "DEP_MISSING"})
            return 1

    if not args.action:
        _emit({"success": False, "error": "No --action provided", "code": "MISSING_ACTION"})
        return 1

    fn = ACTIONS.get(args.action)
    if fn is None:
        _emit({"success": False, "error": f"Unknown action: {args.action}", "code": "UNKNOWN_ACTION", "available": sorted(ACTIONS.keys())})
        return 1

    try:
        params = _load_params(args)
    except json.JSONDecodeError as e:
        _emit({"success": False, "error": f"Invalid JSON params: {e}", "code": "BAD_PARAMS"})
        return 1

    try:
        result = fn(**params)
        _ok(result)
        return 0
    except Exception as e:
        logger.error("action %s crashed: %s\n%s", args.action, e, traceback.format_exc())
        _fail(e)
        return 3


if __name__ == "__main__":
    sys.exit(main())
