#!/usr/bin/env python3
"""
Build a per-platform npm sub-package that bundles:
- Relocatable CPython 3.12 from python-build-standalone (PBS)
- Pre-installed pip wheels (pptx, openpyxl, Pillow, ...)
- The Python scripts from scripts/ppt-master/, scripts/excel/, scripts/docx/ and scripts/pdf/

Output: npm-dist/<platform>/ directory ready to publish.

Usage:
    python3 scripts/build-platform-package.py \
        --platform darwin-arm64 \
        --out npm-dist/darwin-arm64 \
        --version 1.0.0
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

# === Configuration (pinned) ===

PBS_TAG = "20260814"  # https://github.com/astral-sh/python-build-standalone/releases/tag/20260814
PYTHON_VERSION = "3.12.14"  # Pinned to the CPython version this PBS_TAG ships

# Map our 5 supported platform triples to PBS asset suffixes.
PLATFORM_TO_PBS_SUFFIX = {
    "darwin-arm64":        f"aarch64-apple-darwin-install_only_stripped",
    "darwin-x64":          f"x86_64-apple-darwin-install_only_stripped",
    "linux-x64-gnu":       f"x86_64-unknown-linux-gnu-install_only_stripped",
    "linux-arm64-gnu":     f"aarch64-unknown-linux-gnu-install_only_stripped",
    "win32-x64-msvc":      f"x86_64-pc-windows-msvc-install_only_stripped",
}

# OS / CPU per platform triple (for npm platform gating)
PLATFORM_TO_OS_CPU = {
    "darwin-arm64":    (["darwin"],     ["arm64"]),
    "darwin-x64":      (["darwin"],     ["x64"]),
    "linux-x64-gnu":   (["linux"],      ["x64"]),
    "linux-arm64-gnu": (["linux"],      ["arm64"]),
    "win32-x64-msvc":  (["win32"],      ["x64"]),
}

PYTHON_BIN_NAME = "python.exe" if platform.system() == "Windows" else "python3.12"

REQUIREMENTS_FILES = [
    "scripts/ppt-master/requirements.txt",
    "scripts/excel/requirements.txt",
    "scripts/docx/requirements.txt",
]

# Modules the embedded Python must successfully import (smoke check).
SMOKE_IMPORT_MODULES = [
    "pptx", "openpyxl", "PIL",
    "mammoth", "markdownify", "ebooklib", "nbconvert",
    "requests", "bs4", "curl_cffi",
    "google.genai", "flask", "edge_tts",
    "svglib", "reportlab", "fitz", "numpy", "lxml",
    "docx",
]

PACKAGE_SCOPE = ""  # Unscoped to avoid requiring npm org creation; main package is also unscoped.
PACKAGE_NAME_TEMPLATE = f"general-tools-mcp-server-runtime-{{platform}}"
PACKAGE_DESCRIPTION = "Embedded Python 3.12 + pip deps for general-tools-mcp-server"


def log(msg: str) -> None:
    print(f"[build-platform] {msg}", flush=True)


def run(cmd: list[str], cwd: Path | None = None, check: bool = True) -> None:
    log(" ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=check)


def download_pbs(platform_triple: str, out_dir: Path) -> Path:
    """Download PBS tarball for the given platform triple."""
    suffix = PLATFORM_TO_PBS_SUFFIX[platform_triple]
    url = (
        f"https://github.com/astral-sh/python-build-standalone/releases/download/"
        f"{PBS_TAG}/cpython-{PYTHON_VERSION}+{PBS_TAG}-{suffix}.tar.gz"
    )
    tarball = out_dir / "pbs.tar.gz"
    log(f"Downloading {url}")
    try:
        urllib.request.urlretrieve(url, tarball)
    except Exception as e:
        raise SystemExit(
            f"Failed to download PBS tarball ({url}): {e}\n"
            f"Verify PBS_TAG ({PBS_TAG}) and platform triple ({platform_triple}) are correct."
        )
    return tarball


def extract_pbs(tarball: Path, out_dir: Path) -> Path:
    """Extract PBS tarball to <out_dir>/python/. Strip the leading directory.

    Python 3.12's tarfile.extract() does not apply member.mode to extracted
    files (3.14 added that). PBS bundles python3.12 as mode 0775; without
    this chmod pass, files land with default umask (0644) and the embedded
    interpreter cannot be spawned.
    """
    python_dir = out_dir / "python"
    if python_dir.exists():
        shutil.rmtree(python_dir)
    python_dir.mkdir(parents=True)
    log(f"Extracting {tarball.name} -> python/")
    with tarfile.open(tarball, "r:gz") as tf:
        # PBS tarballs have a single top-level dir like "python/"
        # Strip it so the contents land directly in python/.
        for member in tf.getmembers():
            # Skip the top-level directory itself
            if member.name.count("/") <= 1 and member.isdir():
                continue
            # Strip first path component
            stripped_name = "/".join(member.name.split("/")[1:])
            if not stripped_name:
                continue
            member.name = stripped_name
            tf.extract(member, python_dir)
            # Restore the original mode. Symlinks are no-ops for chmod on
            # POSIX (we don't follow them); on Windows islink is false.
            target = python_dir / stripped_name
            try:
                os.chmod(target, member.mode & 0o7777)
            except (OSError, NotImplementedError):
                pass
    return python_dir


def install_pip_deps(python_dir: Path, out_dir: Path) -> None:
    """pip install all requirements into the embedded Python's site-packages.

    On POSIX (PBS install_only_stripped layout): default site-packages is
    `<python>/lib/python3.12/site-packages`, auto-discovered via sys.path.

    On Windows (PBS install_only_stripped layout): default site-packages is
    `<python>/Lib/site-packages` (capital L, no version subdir), locked in
    by the bundled `python3xx._pth` file. Using `--target` to write into a
    non-default path makes the smoke-test invocation fail with
    ModuleNotFoundError because that path is not on sys.path.

    Solution: drop `--target` so pip installs into the auto-detected
    site-packages, which the smoke test can then import directly.
    """
    python_bin = python_dir / "bin" / PYTHON_BIN_NAME
    if not python_bin.exists():
        # On Windows: python.exe is at python/ (no bin/ subdir)
        win_bin = python_dir / PYTHON_BIN_NAME
        if win_bin.exists():
            python_bin = win_bin

    for req_file in REQUIREMENTS_FILES:
        if not Path(req_file).exists():
            log(f"WARN: requirements file missing: {req_file} (skipping)")
            continue
        log(f"pip install --prefer-binary -r {req_file}")
        run([
            str(python_bin), "-m", "pip", "install",
            "--prefer-binary",
            "-r", req_file,
        ], check=False)  # some packages (like pandoc fallbacks) may not be on PyPI


def rewrite_pip_wrappers(python_dir: Path) -> None:
    """Rewrite pip-installed entry-point scripts to use a PBS-style sh wrapper.

    pip writes `#!<build-machine absolute path>/python3.12` into every entry
    point it creates in `<python>/bin/` (because `sys.executable` is the
    absolute path it was invoked from). On the user's machine that path
    doesn't exist, so the wrapper can't run.

    The fix replaces the first line with `#!/bin/sh` + an `exec` that resolves
    the python binary relative to the script's own location. Same pattern
    PBS uses for its bundled 2to3/pip/pip3/idle3/pydoc3 wrappers.

    On Windows, pip installs entry points as .exe launchers rather than text
    scripts, so this pass is a no-op there. That's expected: the runtime never
    invokes those launchers — it spawns python.exe directly — so their
    build-machine shebang is harmless.
    """
    bin_dir = python_dir / "bin"
    if not bin_dir.exists():
        # Windows layout: no bin/ subdir, scripts go in python/ itself.
        bin_dir = python_dir

    target = PYTHON_BIN_NAME  # "python3.12" on POSIX, "python.exe" on Windows

    rewritten = 0
    for f in sorted(bin_dir.iterdir()):
        if not f.is_file() or f.is_symlink():
            continue
        # Skip large binaries (python.exe / python312.dll on Windows): the
        # `#!` prefix check would skip them anyway, but reading ~18MB into
        # memory just to fail the prefix test is wasteful.
        if f.stat().st_size > 1_000_000:
            continue
        try:
            content = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if not content.startswith("#!"):
            continue
        first_line, _, rest = content.partition("\n")
        # Already a portable sh wrapper (PBS-bundled: 2to3/pip/pip3/idle3/pydoc3).
        if first_line == "#!/bin/sh":
            continue
        # Skip shebangs that don't reference an absolute python path —
        # they're already portable (e.g. #!/usr/bin/env python3).
        if "/python" not in first_line and "python.exe" not in first_line:
            continue

        new_content = (
            "#!/bin/sh\n"
            "'''exec' \"$(dirname -- \"$(realpath -- \"$0\")\")/"
            f"{target}\" \"$0\" \"$@\"\n"
            "' '''\n"
            f"{rest}"
        )
        f.write_text(new_content)
        rewritten += 1
    if rewritten:
        log(f"rewrote shebang of {rewritten} pip entry-point script(s)")


def chmod_bin_executables(python_dir: Path) -> None:
    """Ensure every file under python/bin/ has +x for owner, group, other.

    Belt-and-suspenders after extract_pbs's per-member chmod: pip writes
    entry-point scripts with default umask (typically 0644). Without this
    pass the wrappers would still be unrunnable on the user's machine even
    after their shebang was rewritten.
    """
    bin_dir = python_dir / "bin"
    if not bin_dir.exists():
        bin_dir = python_dir

    fixed = 0
    for f in bin_dir.iterdir():
        if not f.is_file() or f.is_symlink():
            continue
        mode = f.stat().st_mode
        if not (mode & 0o111):  # no exec bit at all
            os.chmod(f, mode | 0o755)
            fixed += 1
    if fixed:
        log(f"chmod +x on {fixed} script(s) in python/bin/")


def copy_scripts(out_dir: Path) -> None:
    """Copy scripts/ppt-master/ and scripts/excel/ to <out_dir>/scripts/."""
    target = out_dir / "scripts"
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    for src in ("scripts/ppt-master", "scripts/excel", "scripts/docx", "scripts/pdf"):
        if not Path(src).exists():
            log(f"WARN: source script dir missing: {src}")
            continue
        dest = target / Path(src).name
        log(f"cp -r {src} -> {dest}")
        shutil.copytree(src, dest)


def write_package_json(platform_triple: str, version: str, out_dir: Path) -> None:
    """Generate the platform sub-package's package.json."""
    os_values, cpu_values = PLATFORM_TO_OS_CPU[platform_triple]
    pkg_name = PACKAGE_NAME_TEMPLATE.format(platform=platform_triple)
    pkg = {
        "name": pkg_name,
        "version": version,
        "description": PACKAGE_DESCRIPTION,
        "files": ["python/", "scripts/"],
        "os": os_values,
        "cpu": cpu_values,
        "engines": {"node": ">=18"},
        "license": "MIT",
        "publishConfig": {"access": "public"},
    }
    out_path = out_dir / "package.json"
    out_path.write_text(json.dumps(pkg, indent=2) + "\n")
    log(f"wrote {out_path}")


def macos_unquarantine(python_dir: Path) -> None:
    """Strip macOS quarantine attrs from the embedded python binary.
    NOTE: this only clears the BUILD machine's copy; users must re-run on their machine.
    """
    if platform.system() != "Darwin":
        return
    python_bin = python_dir / "bin" / PYTHON_BIN_NAME
    if not python_bin.exists():
        return
    log(f"xattr -dr com.apple.quarantine {python_bin} (build machine only)")
    subprocess.run(
        ["xattr", "-dr", "com.apple.quarantine", str(python_bin)],
        check=False, capture_output=True,
    )


def smoke_test(python_dir: Path) -> None:
    """Verify the embedded Python can import all required modules.

    `import PIL` alone only loads PIL/__init__.py and does NOT trigger the
    `_imaging` C extension, so a broken Pillow install (e.g. the macOS
    wheel's .dylibs stripped during artifact upload) would silently pass.
    Load `PIL.Image` explicitly to force _imaging to dlopen its bundled
    dylibs and fail the build early.
    """
    python_bin = python_dir / "bin" / PYTHON_BIN_NAME
    if not python_bin.exists():
        python_bin = python_dir / PYTHON_BIN_NAME
    smoke = ", ".join(SMOKE_IMPORT_MODULES)
    log(f"smoke import: {smoke}")
    run([str(python_bin), "-c", f"import {smoke}; print('embedded python OK')"])
    # Force PIL's C extension to load; catches missing .dylibs on macOS
    # wheels that `import PIL` alone would miss.
    log("smoke load: PIL.Image (forces _imaging dylib loading)")
    run([str(python_bin), "-c", "from PIL import Image; print('PIL Image OK')"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=list(PLATFORM_TO_PBS_SUFFIX.keys()))
    parser.add_argument("--out", required=True, help="Output directory (e.g. npm-dist/darwin-arm64)")
    parser.add_argument("--version", required=True, help="Package version (must match main pkg)")
    args = parser.parse_args()

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    log(f"platform={args.platform} version={args.version} out={out_dir}")

    # Step 1: download PBS
    tarball = download_pbs(args.platform, out_dir)
    try:
        # Step 2: extract PBS
        python_dir = extract_pbs(tarball, out_dir)

        # Step 3: pip install deps
        install_pip_deps(python_dir, out_dir)

        # Step 3.5: fix pip wrappers (shebang + +x). Must run before smoke_test
        # because smoke_test only invokes python3.12 directly, but a downstream
        # npm install will try to run the pip-installed entry points too.
        rewrite_pip_wrappers(python_dir)
        chmod_bin_executables(python_dir)

        # Step 4: copy Python scripts (preserving directory layout)
        copy_scripts(out_dir)

        # Step 5: write platform sub-package.json
        write_package_json(args.platform, args.version, out_dir)

        # Step 6: macOS quarantine strip (build machine only)
        macos_unquarantine(python_dir)

        # Step 7: smoke test
        smoke_test(python_dir)
    finally:
        # Always clean up the downloaded tarball
        if tarball.exists():
            tarball.unlink()

    log(f"DONE: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())