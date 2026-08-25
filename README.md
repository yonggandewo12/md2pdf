# General Tools — MCP Server

基于 [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) 的通用工具服务器，提供 HTML/Markdown 转 PDF/图片、OCR 文字识别等能力。底层使用 Puppeteer（无头 Chrome）进行浏览器级渲染，确保输出与浏览器表现一致。

---

## 功能特性

- **HTML 转 PDF** — 支持 HTML 文件或 HTML 内容字符串
- **HTML 转图片** — HTML 文件或内容 → PNG/JPEG 截图，支持全页/视口、自定义质量与缩放
- **Markdown 转 PDF** — 内置专业级报告排版，自动生成侧边栏目录
- **完整 CSS/JS 支持** — Chart.js、Mermaid 等动态内容均可渲染
- **丰富的 PDF 参数** — 页面尺寸、边距、缩放、页眉页脚、网络等待等
- **图片自动嵌入** — 本地图片自动转为 base64 嵌入，单文件可离线分享
- **Mermaid 图表** — Markdown 中的 Mermaid 代码块自动渲染
- **侧边栏目录** — 层级嵌套、粘性定位，长文档导航无压力
- **响应式表格** — 宽表可横向滚动，移动端友好
- **交互增强** — 可选 JS 提供滚动进度条、目录高亮、返回顶部
- **打印优化** — 专门的 `@media print` 样式
- **浏览器实例复用** — 首次启动后后续转换只需 ~0.5-1s
- **OCR 文字识别** — 基于百度智能云 OCR，支持图片、PDF、OFD 文字提取，25+ 种语言
- **PPT 生成** — 将 AI 生成的 SVG 幻灯片导出为原生可编辑 PPTX，支持动画与切换效果
- **AI 图片生成** — 对接 18+ 后端（OpenAI、Gemini、Qwen、Agnes AI 等），支持文生图和图生图
- **文档转 Markdown** — PDF、DOCX、Excel、PowerPoint、网页 → 结构化 Markdown
- **Excel 操作** — 创建/读写工作簿、格式化、公式、合并、图表、透视汇总表、原生 Table、行列增删、数据验证（25 个工具，基于 openpyxl）
- **DOCX 生成** — HTML/Markdown/纯文本 → 带样式的 Word 文档（基于 `docx` npm 包，纯 JS）
- **DOCX 编辑** — 打开已有 .docx 改段落/插图片/插表格/改样式/读结构（基于 python-docx，已嵌入运行时）
- **PDF 后处理** — 给 PDF 加文字/图片水印、嵌入二维码（基于 pdf-lib，纯 JS）
- **PDF 操作** — 合并/拆分/提取/压缩/加密/解密（pdf-lib + PyMuPDF）
- **PPTX 读取/编辑** — 读取已有 PPT 结构/文本/渲染图片，替换文字/表格/复制页/加备注/设转场（python-pptx + template_fill_pptx）
- **图片处理** — 格式转换/缩放/压缩/旋转/裁切/水印（基于 Pillow）

---

## 从 npm 远程安装（推荐）

发布到 npm 后，**用户侧只需两个命令**：

```bash
# 1. 全局安装（主包 + 自动拉匹配平台的 Python 嵌入子包）
npm install -g general-tools-mcp-server

# 2. 注册 MCP（路径解析到全局 node_modules）
claude mcp add general-tools -- node "$(npm root -g)/general-tools-mcp-server/dist/index.js"

# 3. 验证
claude mcp list | grep general-tools
```

**首次运行需要解锁嵌入 Python**（每个用户机器上各跑一次，build 端清除不传播）：

```bash
# macOS Apple Silicon — Gatekeeper quarantine
PY="$(node -e "console.log(require.resolve('general-tools-mcp-server-runtime-darwin-arm64/package.json').replace('/package.json','/python/bin/python3.12'))")"
xattr -dr com.apple.quarantine "$PY"
"$PY" --version   # → Python 3.12.14

# macOS Intel — 上一步换 runtime-darwin-arm64 为 runtime-linux-x64-gnu 是错的；
# 当前 darwin-x64 (Intel Mac) 暂未发布，Intel Mac 用户需 PPT_MASTER_PYTHON 回退系统 Python

# Windows — SmartScreen Unblock
# PowerShell: Unblock-File "$env:USERPROFILE\node_modules\general-tools-mcp-server-runtime-win32-x64-msvc\python\python.exe"

# Linux — 验证 glibc ≥ 2.31
ldd --version | head -1
```

> **包名锁定 `general-tools-mcp-server`**：npm 上另一个 `general-tools@0.0.5` 是别人的包，与本项目无关。

---

## 从 0 到 1 完整安装（本地开发）

### 第一步：检查前置依赖

```bash
# Node.js 18+（必需）
node --version
```

**Python 已嵌入 npm 包，无需在主机上预先安装**。`general-tools-mcp-server-runtime-<platform>` 子包会随 `npm install` 自动按平台拉取（darwin-arm64 / linux-x64-gnu / linux-arm64-gnu / win32-x64-msvc），内含 CPython 3.12 + 全部 pip 依赖（pptx、openpyxl、Pillow 等）。

如果想用主机上自带的 Python（向后兼容），设置 `PPT_MASTER_PYTHON` 即可跳过嵌入运行时。

> **说明**：`convert_to_markdown` 的 Office 文档转换（Word/Excel/PowerPoint/ODF/RTF/EPUB/CSV）默认走内置 anydoc 内核（Rust 编译、Node 绑定）；PDF 转换走 `@firecrawl/pdf-inspector`（Rust + NAPI）；嵌入的 Python 仅用于 PPT 生成（`generate_presentation`）、25 个 `excel_*` 工具、DOCX 编辑（`docx_read_document`/`docx_edit_paragraph`/`docx_add_paragraph`/`docx_insert_image`/`docx_insert_table`/`docx_change_style` 等）、`convert_to_markdown` 的 HTML/IPYNB/Web/Office-fallback 路径。`@firecrawl/anydoc` 与 `@firecrawl/pdf-inspector` 的预编译二进制都以 remote URL 依赖分发，若本机 `npm` 开启了 `allow-remote=none`，需用 `npm install --allow-remote=all` 一次性装齐。

### 第二步：安装项目依赖

```bash
# 进入项目目录
cd /Users/xuliang/Documents/project/general-tools

# 安装 Node.js 依赖（会自动拉取嵌入 Python 子包）
npm install --allow-remote=all

# 编译 TypeScript → JavaScript
npm run build
```

**Python 依赖** 已嵌入，无需手动 `pip install`。仅当使用自备 Python（`PPT_MASTER_PYTHON`）时需手动：
```bash
python3.12 -m pip install --break-system-packages -r scripts/ppt-master/requirements.txt
python3.12 -m pip install --break-system-packages -r scripts/excel/requirements.txt
python3.12 -m pip install --break-system-packages -r scripts/docx/requirements.txt
```

### 第三步：配置 Claude Code MCP（可选）

两种方式二选一：

**方式 A — CLI 一键添加（推荐）：**

```bash
# 基础配置（所有 10 个工具可用，但不含 OCR / AI 图片）
claude mcp add general-tools \
  -- node /Users/xuliang/Documents/project/general-tools/dist/index.js
```

**方式 B — 配置文件（`~/.claude.json`）：**

```json
{
  "mcpServers": {
    "general-tools": {
      "command": "node",
      "args": ["/Users/xuliang/Documents/project/general-tools/dist/index.js"]
    }
  }
}
```

> **配置文件位置对照：**
> - **Claude Code（用户级）：** `~/.claude.json`
> - **Claude Code（项目级）：** `.claude.json`
> - **Claude Desktop：** `~/Library/Application Support/Claude/claude_desktop_config.json`

配置后重启 Claude Code，执行 `claude mcp list` 应看到 71 个工具（10 个通用 + 25 个 Excel + 13 个 DOCX/PDF + 6 个 PDF 操作 + 10 个 PPTX 编辑 + 7 个图片处理）。

### 平台支持与首次运行提示

**支持的 5 个平台子包**（自动按 `process.platform` + `process.arch` 选择）：

| 平台子包 | 适用主机 |
|---|---|
| `general-tools-mcp-server-runtime-darwin-arm64` | macOS Apple Silicon（M1/M2/M3/M4） |
| `general-tools-mcp-server-runtime-linux-x64-gnu` | Linux x86_64（glibc ≥ 2.31） |
| `general-tools-mcp-server-runtime-linux-arm64-gnu` | Linux ARM64（glibc ≥ 2.31） |
| `general-tools-mcp-server-runtime-win32-x64-msvc` | Windows 10/11 x64 |

> 区别于 `@firecrawl/pdf-inspector`（仅 ARM64），本项目显式覆盖 **Intel Mac 与 Windows**。

#### macOS Gatekeeper（首次运行需解锁）

未签名的嵌入 Python 会被 macOS Gatekeeper 拦截（`xattr` quarantine）。**每个用户机器上需手动运行一次**（build 端的清除不会传播）：

```bash
SUFFIX=$(node -e "console.log(process.platform+'-'+process.arch)")
PY="$(node -e "console.log(require.resolve('general-tools-mcp-server-runtime-'+'$SUFFIX'+'/package.json').replace('/package.json','/python/bin/python3.12'))")"
xattr -dr com.apple.quarantine "$PY"
"$PY" --version   # → Python 3.12.14
```

#### Windows SmartScreen（首次运行需解锁）

未签名的 `python.exe` 会被 SmartScreen 警告。**两种方式二选一**：

```powershell
# 方式 A — PowerShell 一键解锁
Unblock-File "$env:USERPROFILE\node_modules\general-tools-mcp-server-runtime-win32-x64-msvc\python\python.exe"

# 方式 B — 文件资源管理器
# 右键 python.exe → Properties → 勾选 "Unblock" → Apply
```

#### Linux glibc 要求

嵌入 Python 要求系统 glibc ≥ 2.31（覆盖 Ubuntu 20.04+、Debian 11+、CentOS Stream 9+、Alpine 3.13+ musl-static variant）：

```bash
ldd --version | head -1   # → ldd (Ubuntu GLIBC 2.35-0ubuntu3) 2.35
```

若低于 2.31（如 CentOS 7、Debian 10），安装系统 Python 3.10+ 并设置 `PPT_MASTER_PYTHON` 环境变量。

### 第四步（可选）：配置扩展功能的环境变量

某些功能需要第三方服务的 API Key。以下均为**可选**，不配置不影响其他工具。

```bash
# 完整配置版（按需添加 -e 参数）
claude mcp add general-tools \
  -e BAIDU_OCR_API_KEY=你的百度OCRKey \
  -e BAIDU_OCR_SECRET_KEY=你的百度OCRSecret \
  -e IMAGE_BACKEND=gemini \
  -e GEMINI_API_KEY=你的GeminiKey \
  -- node /Users/xuliang/Documents/project/general-tools/dist/index.js
```

**各功能的环境变量说明：**

| 功能 | 涉及工具 | 需要配置的变量 | 如何获取 |
|------|---------|---------------|---------|
| **OCR 文字识别** | `recognize_text` | `BAIDU_OCR_API_KEY` + `BAIDU_OCR_SECRET_KEY` | [百度智能云](https://console.bce.baidu.com/ai/#/ai/ocr/overview/index) 创建应用 |
| **AI 图片生成** | `generate_image` | `IMAGE_BACKEND` + 对应后端 API Key（见下方） | 选择一家服务商 |
| **PDF OCR 路由** | `extract_pdf_text` / `convert_to_markdown` (PDF) | `PDFIUM_LIB_PATH` + `ORT_DYLIB_PATH`（仅扫描型 PDF 需 OCR 时） | 默认走纯文本提取，扫描型 PDF 文本不可靠时才启用 |
| **Python 路径**（可选） | `generate_presentation` / `excel_*` / `docx_edit_*` / `docx_insert_*` / `convert_to_markdown`（HTML/IPYNB/Web/Office-fallback） | `PPT_MASTER_PYTHON`（默认用嵌入 Python；设置后改用主机 Python） | 仅当嵌入 Python 出问题时回退到系统 Python |

**AI 图片生成后端选择（`IMAGE_BACKEND` + 对应 Key）：**

| 后端 | 推荐模型 | 需额外配置 | 备注 |
|------|---------|-----------|------|
| `openai` | gpt-image-2 | `OPENAI_API_KEY=sk-xxx` | [OpenAI](https://platform.openai.com/api-keys)，付费 |
| `gemini` | gemini-3.1-flash-image-preview | `GEMINI_API_KEY=xxx` | [Google AI Studio](https://aistudio.google.com/apikey)，免费额度 |
| `qwen` | qwen-image-2.0-pro | `QWEN_API_KEY=xxx` | 阿里通义万相 |
| `zhipu` | glm-image | `ZHIPU_API_KEY=xxx` | 智谱 GLM |
| `volcengine` | doubao-seedream | `VOLCENGINE_API_KEY=xxx` | 火山引擎 |
| `agnes` | agnes-image-2.1-flash | `AGNES_API_KEY=xxx` | Agnes AI，支持图生图 |

例如使用 Gemini（免费）：
```bash
claude mcp add general-tools \
  -e IMAGE_BACKEND=gemini \
  -e GEMINI_API_KEY=你的GoogleAPIKey \
  -- node /Users/xuliang/Documents/project/general-tools/dist/index.js
```

### 验证安装

配置后重启 Claude，让它帮你测试：

```
帮我用 convert_to_markdown 把 package.json 转成 Markdown
```

```
claude mcp list
# 应看到: generate_presentation, generate_image, convert_to_markdown 等 10 个工具
```

### 卸载

```bash
claude mcp remove general-tools
```

---

## 使用指南

### 工具 1：`convert_html_to_pdf`

HTML 文件或内容 → PDF。

```
Claude，把 report.html 转成 PDF，A4 格式，80% 缩放
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `htmlPath` | string | HTML 文件路径 | - |
| `htmlContent` | string | HTML 内容字符串（与 htmlPath 二选一） | - |
| `outputPath` | string | 输出 PDF 路径 | 自动生成带时间戳 |
| `format` | enum | 纸张大小 (A4/A3/Letter/Legal/Tabloid) | A4 |
| `landscape` | boolean | 横向 | false |
| `printBackground` | boolean | 打印背景 | true |
| `scale` | number | 缩放 0.1-2.0 | 1 |
| `marginTop/Bottom/Left/Right` | string | 边距 | 10mm |
| `displayHeaderFooter` | boolean | 显示页眉页脚 | false |
| `headerTemplate` | string | 页眉模板 | - |
| `footerTemplate` | string | 页脚模板 | - |
| `waitForNetworkIdle` | boolean | 等待网络空闲 | false |
| `timeout` | number | 超时(ms) | 30000 |

### 工具 2：`convert_html_to_image`

HTML 文件或内容 → 图片（PNG/JPEG）。支持全页截图或视口截图，可自定义输出质量和缩放比例。

```
Claude，把 report.html 转成高清 PNG 图片
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `htmlPath` | string | HTML 文件路径 | - |
| `htmlContent` | string | HTML 内容字符串（与 htmlPath 二选一） | - |
| `outputPath` | string | 输出图片路径 | 自动生成带时间戳 |
| `imageFormat` | enum | 图片格式 (png/jpeg) | png |
| `quality` | number | JPEG 质量 0-100 | 90 |
| `fullPage` | boolean | 捕获全页高度 | false |
| `imageScale` | number | 截图缩放比例 0.1-2.0 | 1 |
| `waitForNetworkIdle` | boolean | 等待网络空闲后再截图 | false |
| `waitForMermaid` | boolean | 等待 Mermaid 图表渲染完成 | false |
| `timeout` | number | 超时(ms) | 30000 |

### 工具 3：`convert_md_to_html`

Markdown 文件或内容 → 独立、可离线打开的 HTML 报告。带侧边栏目录、响应式表格、Mermaid 图表渲染、图片自动嵌入。

```
Claude，把 README.md 转成 HTML 报告，带交互导航
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `mdPath` | string | Markdown 文件路径 | - |
| `mdContent` | string | Markdown 字符串（与 mdPath 二选一） | - |
| `outputPath` | string | 输出 HTML 路径 | 与输入 .md 同名.html |
| `embedImages` | boolean | 本地图片嵌入为 base64 | true |
| `keepInlineToc` | boolean | 保留正文中已有的目录 | false |
| `withJs` | boolean | 添加 JS 交互（进度条/目录高亮/回顶） | false |
| `mermaidSource` | enum | Mermaid 来源 (auto/cdn/local/none) | auto |

### 工具 4：`convert_md_to_pdf`

Markdown 文件或内容 → 排版后的 PDF。（推荐）

```
Claude，把 README.md 转成 PDF，A4 格式，带交互导航
```

**特有参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `mdPath` | string | Markdown 文件路径 | - |
| `mdContent` | string | Markdown 字符串（与 mdPath 二选一） | - |
| `embedImages` | boolean | 本地图片嵌入为 base64 | true |
| `keepInlineToc` | boolean | 保留正文中已有的目录 | false |
| `withJs` | boolean | 添加 JS 交互（进度条/目录高亮/回顶） | false |
| `mermaidSource` | enum | Mermaid 来源 (auto/cdn/local/none) | auto |

其余 PDF 参数（`format`, `landscape`, `scale` 等）与 HTML 工具一致。

### 工具 5：`recognize_text`

基于百度智能云 OCR API，从图片、PDF 或 OFD 文件中提取文字，支持中英文及多种语言。

```
Claude，识别 /path/to/image.png 中的文字
Claude，识别 /path/to/document.pdf 第2页的文字
Claude，识别 /path/to/doc.ofd 中的文字
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `imagePath` | string | 本地图片文件路径（图片三选一） | - |
| `imageUrl` | string | 网络图片 URL（图片三选一） | - |
| `imageBase64` | string | Base64 编码图片数据（图片三选一） | - |
| `pdfPath` | string | 本地 PDF 文件路径 | - |
| `pdfFileNum` | number | PDF 识别页码，从 1 开始 | 1 |
| `ofdPath` | string | 本地 OFD 文件路径 | - |
| `ofdFileNum` | number | OFD 识别页码，从 1 开始 | 1 |
| `apiKey` | string | 百度智能云 API Key（可选，优先读环境变量 `BAIDU_OCR_API_KEY`） | - |
| `secretKey` | string | 百度智能云 Secret Key（可选，优先读环境变量 `BAIDU_OCR_SECRET_KEY`） | - |
| `languageType` | enum | 识别语言类型（见下表） | CHN_ENG |
| `detectLanguage` | boolean | 检测图片中的语言 | true |
| `detectDirection` | boolean | 检测图像朝向 | false |
| `paragraph` | boolean | 输出段落信息 | false |
| `probability` | boolean | 返回每行置信度分数 | true |
| `multidirectionalRecognize` | boolean | 行级别多方向文字识别（图内有不同方向文字时建议开启） | false |

> **输入优先级：** `image > url > pdf_file > ofd_file`，当 image/url 字段存在时，pdf_file/ofd_file 字段失效。

**`languageType` 可选值：**

| 值 | 语言 | 值 | 语言 |
|----|------|----|------|
| `auto_detect` | 自动检测 | `CHN_ENG` | 中英文混合 |
| `ENG` | 英文 | `JAP` | 日语 |
| `KOR` | 韩语 | `FRE` | 法语 |
| `SPA` | 西班牙语 | `POR` | 葡萄牙语 |
| `GER` | 德语 | `ITA` | 意大利语 |
| `RUS` | 俄语 | `DAN` | 丹麦语 |
| `DUT` | 荷兰语 | `MAL` | 马来语 |
| `SWE` | 瑞典语 | `IND` | 印尼语 |
| `POL` | 波兰语 | `ROM` | 罗马尼亚语 |
| `TUR` | 土耳其语 | `GRE` | 希腊语 |
| `HUN` | 匈牙利语 | `THA` | 泰语 |
| `VIE` | 越南语 | `ARA` | 阿拉伯语 |
| `HIN` | 印地语 | | |

> **认证方式：** 优先使用工具参数 `apiKey`/`secretKey`，未提供时从环境变量 `BAIDU_OCR_API_KEY`/`BAIDU_OCR_SECRET_KEY` 读取。MCP 配置时可通过 `--env` 传入：
> ```bash
> claude mcp add --env BAIDU_OCR_API_KEY=<你的Key> --env BAIDU_OCR_SECRET_KEY=<你的Secret> ...
> ```
>
> **识别策略：** 优先调用高精度接口 `accurate_basic`，失败时自动降级到 `general_basic`。

### 工具 6：`generate_presentation`

创建 ppt-master 项目（Prepare 模式）或将已有 SVG 项目导出为 PPTX（Export 模式）。

> **重要：** 本工具只做机械化的项目准备和 PPTX 导出。AI 驱动的 SVG 幻灯片生成（Strategist → Executor 环节）需通过 Claude Code 的 ppt-master SKILL.md 工作流完成。先由 AI 生成 `svg_output/*.svg`，再调此工具导出。

```
Claude，创建一个新 PPT 项目，用这份 Markdown 内容
Claude，把已有的项目 /path/to/project 导出为 PPTX
```

**两阶段使用：**

1. **Prepare 阶段：** 传入 `markdownContent`/`markdownPath`/`sourceUrl`/`sourceFile` → 创建项目目录并导入源文件
2. **Export 阶段：** 在 `svg_output/` 中放入 AI 生成的 SVG → 传入 `projectDir` → 运行 `finalize_svg.py` + `svg_to_pptx.py` → 产出 PPTX

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `projectDir` | string | 已有项目目录（Export 模式） | - |
| `markdownContent` | string | Markdown 内容（Prepare 模式） | - |
| `markdownPath` | string | Markdown 文件路径（Prepare 模式） | - |
| `sourceUrl` | string | 源 URL（Prepare 模式） | - |
| `sourceFile` | string | 源文件路径 pdf/docx/xlsx/pptx（Prepare 模式） | - |
| `projectName` | string | 项目名称 | 自动推断 |
| `outputDir` | string | 项目创建目录 | cwd |
| `canvasFormat` | enum | 画布格式 (ppt169/ppt43/wechat/xiaohongshu/moments/story/banner/a4) | ppt169 |
| `outputPath` | string | 导出 PPTX 路径（Export 模式） | 自动生成 |
| `svgSource` | enum | SVG 源目录 (output/final) | output |
| `transition` | string | 幻灯片切换效果，如 fade | - |
| `animation` | string | 逐元素进入动画，如 auto | - |
| `timeout` | number | 超时(ms) | 120000 |

### 工具 7：`generate_image`

基于 AI 图片生成后端（通过环境变量配置），从文字提示生成图片。支持 18+ 后端：OpenAI、Gemini、Qwen、Zhipu、Volcengine、Agnes AI、Stability、BFL 等。Agnes AI 后端额外支持图生图（image-to-image）模式。

```
Claude，生成一张"日落海滩"的图片，16:9 比例
```

**环境变量配置示例（MCP 配置时传入）：**

```bash
claude mcp add --transport stdio \
  --env IMAGE_BACKEND=openai \
  --env OPENAI_API_KEY=sk-xxx \
  --scope user general-tools -- node $(pwd)/dist/index.js
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `prompt` | string (必填) | 图片生成提示词 | - |
| `aspectRatio` | string | 宽高比 | 16:9 |
| `imageSize` | string | 图片尺寸 (512px/1K/2K/4K) | 1K |
| `backend` | string | 后端覆盖，如 openai/gemini/agnes | 环境变量 IMAGE_BACKEND |
| `outputDir` | string | 输出目录 | cwd |
| `filename` | string | 输出文件名（不含扩展名） | 自动生成 |
| `model` | string | 模型覆盖 | 后端默认模型 |
| `referenceImage` | string | 参考图片 URL（图生图，Agnes AI 后端支持） | - |
| `timeout` | number | 超时(ms) | 120000 |

### 工具 8：`convert_to_markdown`

将 PDF、Word（docx/doc/odt/rtf/epub）、Excel（xlsx/xls/xlsb/ods/csv）、PowerPoint（pptx/ppt/odp）、网页 URL 等转换为 Markdown 格式。自动根据文件扩展名或 URL 检测源类型。

```
Claude，把 report.pdf 转成 Markdown
Claude，把 https://example.com 转为 Markdown
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `source` | string (必填) | 源文件路径或 URL | - |
| `sourceType` | enum | 源类型 (auto/pdf/doc/excel/ppt/web) | auto |
| `outputPath` | string | 输出 Markdown 路径 | 输入文件名.md |
| `maxRows` | number | Excel 每表最大行数（指定时该转换走 Python 子进程截断） | 无限制 |
| `maxCols` | number | Excel 每表最大列数（指定时该转换走 Python 子进程截断） | 无限制 |
| `pdfImages` | enum | PDF 图片提取 (all/filtered/none) | filtered |
| `renderVectorFigures` | boolean | 渲染 PDF 矢量图为 PNG | false |
| `vectorFigureDpi` | number | 矢量图渲染 DPI | 150 |

> **内核与格式说明：**
> - Word/Excel/PowerPoint/ODF/RTF/EPUB/CSV 默认走 **anydoc** 内核（Rust 编译、Node 绑定，毫秒级转换），内嵌图片以 alt 文本保留、原始文件落到 `<输出名>_files/` 目录。
> - PDF 走 `@firecrawl/pdf-inspector`（Rust + NAPI，多列阅读顺序、表格识别、毫秒级）；**不返回图片字节流**（`pdfImages` 选项对 PDF 是 no-op），需要原图请用 `screenshot_pdf` 出页面截图。
> - 网页 URL 走 Python 抓取。
> - `.potx/.potm`（PowerPoint 模板）不受支持，请先另存为 `.pptx`。
> - 指定 `maxRows`/`maxCols` 会回退 Python `excel_to_md.py`（保留行/列截断语义）。

### 工具 9–33：Excel 操作（`excel_*`）

25 个工具，基于 openpyxl（Python 子进程）的完整 Excel 操作能力。所有工具以 `excel_` 前缀，`filepath` 接受绝对或相对路径。

| 工具 | 说明 |
|------|------|
| `excel_create_workbook` | 创建新工作簿 |
| `excel_create_worksheet` | 新建工作表 |
| `excel_get_workbook_metadata` | 工作簿元数据（工作表列表、大小、使用范围） |
| `excel_write_data` | 写入二维数据（自动建表） |
| `excel_read_data` | 读取范围数据（含单元格元数据与验证规则） |
| `excel_apply_formula` | 应用公式（校验语法、拦截危险函数） |
| `excel_validate_formula` | 校验公式语法 |
| `excel_format_range` | 格式化（字体/填充/边框/对齐/数字格式/条件格式/合并/保护） |
| `excel_merge_cells` / `excel_unmerge_cells` / `excel_get_merged_cells` | 合并单元格操作 |
| `excel_create_chart` | 创建图表（line/bar/pie/scatter/area） |
| `excel_create_pivot_table` | 创建透视汇总表（sum/average/count/min/max） |
| `excel_create_table` | 创建原生 Excel Table（带样式） |
| `excel_copy_worksheet` / `excel_delete_worksheet` / `excel_rename_worksheet` | 工作表操作 |
| `excel_copy_range` / `excel_delete_range` | 范围复制/删除（保留样式） |
| `excel_validate_range` | 校验范围边界 |
| `excel_get_data_validation` | 查询数据验证规则 |
| `excel_insert_rows` / `excel_insert_columns` / `excel_delete_rows` / `excel_delete_columns` | 行列增删 |

> **依赖**：openpyxl 已嵌入运行时，无需手动安装。Python 路径默认用嵌入 Python；可用 `PPT_MASTER_PYTHON` 改用系统 Python。
| `timeout` | number | 超时(ms) | 120000 |

### 工具 34–46：DOCX / PDF 后处理（`docx_*` / `pdf_*`）

13 个工具，分三组能力：

**DOCX 生成**（基于 `docx` npm 包，纯 JS，无 Python 依赖）：

| 工具 | 说明 |
|------|------|
| `docx_create_document` | 从 HTML 内容（或纯文本，自动包装）创建带样式的 .docx |
| `docx_convert_md_to_docx` | Markdown 内容 → .docx（经 markdown→HTML→DOCX 管线，保留标题/粗斜体/列表/表格/代码块） |
| `docx_convert_html_to_docx` | HTML 内容 → .docx（h1-h6/p/strong/em/ul/ol/table/blockquote/pre 样式映射，含 XSS 清洗） |

**DOCX 编辑已有文档**（基于 python-docx，子进程调用，python-docx 已嵌入运行时）：

| 工具 | 说明 |
|------|------|
| `docx_read_document` | 读取 .docx 结构：段落文本/样式/对齐、表格数、节数、内嵌图片数 |
| `docx_edit_paragraph` | 修改指定段落文字（可选改样式） |
| `docx_add_paragraph` | 文档末尾追加段落（支持粗体/斜体/字号/对齐/样式） |
| `docx_insert_image` | 在指定段落后插入图片（宽高以英寸计，可省略用原始尺寸） |
| `docx_insert_table` | 文档末尾插入表格（二维数据或空网格，带网格样式） |
| `docx_change_style` | 修改段落样式（如 Heading 1 / Title / Normal） |
| `docx_list_tables` | 列出所有表格尺寸与首行预览 |
| `docx_available_styles` | 列出文档可用样式名 |

**PDF 后处理**（基于 pdf-lib，纯 JS，无外部进程）：

| 工具 | 说明 |
|------|------|
| `pdf_add_watermark` | 给 PDF 加文字水印（-30° 斜向平铺，中文自动嵌入系统中文字体）或图片水印（6 种锚点位置，含 fullscreen） |
| `pdf_add_qrcode` | 在 PDF 末页嵌入二维码图片 + 可选说明文字（中文说明自动嵌入中文字体） |

> **依赖**：python-docx 已嵌入运行时（`scripts/build-platform-package.py` 打包），无需手动安装；`docx`/`pdf-lib` 为 npm dependencies，随主包分发。

### 工具 47–52：PDF 操作（`pdf_*`）

6 个工具，页级 PDF 操作。合并/拆分/提取/压缩为纯 JS（pdf-lib），加密/解密走 PyMuPDF（已嵌入运行时）。

| 工具 | 说明 |
|------|------|
| `pdf_merge_pdfs` | 合并多个 PDF 为一个文件（`pdfPaths` 数组 + `outputPath`） |
| `pdf_split_pdf` | 按页码范围拆分（`"1-3,5,7-9"` 语法）为多个文件 |
| `pdf_extract_pages` | 提取指定页到单个新 PDF |
| `pdf_compress_pdf` | 重新打包压缩（`useObjectStreams`，移除增量更新） |
| `pdf_encrypt_pdf` | 设置用户/所有者密码与权限（`permissions`：printing/modifying/copying 等） |
| `pdf_decrypt_pdf` | 输入密码解密 PDF |

> **依赖**：加密/解密需 PyMuPDF（`fitz`/`pymupdf`），已嵌入运行时；其余纯 JS 零依赖。

### 工具 53–62：PPTX 读取/编辑（`pptx_*`）

10 个工具，读取与编辑已有 PowerPoint（python-pptx + template_fill_pptx，均已嵌入运行时）。与 `generate_presentation`（从 SVG 生成新 PPT）互补。

| 工具 | 说明 |
|------|------|
| `pptx_read_presentation` | 总览：页数、尺寸、每页标题与 shape 数 |
| `pptx_read_slide_details` | 单页 shapes 详情（名称/类型/位置/文本/表格） |
| `pptx_extract_text` | 整份转 Markdown（保留标题/项目符号/表格/备注） |
| `pptx_to_images` | 每页渲染为 PNG/JPEG（PyMuPDF 渲染，`"1-3,5"` 选页） |
| `pptx_replace_text` | 按 shape 选择器替换指定页文字 |
| `pptx_replace_table_cells` | 替换指定页表格单元格 |
| `pptx_duplicate_slide` | 复制指定页（追加到末尾，保留原页） |
| `pptx_add_notes` | 给多页添加演讲者备注 |
| `pptx_set_transitions` | 设置转场效果（fade/push/wipe 等） |
| `pptx_apply_plan` | 通用 template_fill_pptx plan 应用（替换/表格/图表/备注/转场） |

> **转场契约**：编辑类工具（`pptx_replace_text` / `pptx_replace_table_cells` / `pptx_duplicate_slide` / `pptx_add_notes`）**保留**源文件的转场设置，不会改动页面切换效果；`pptx_set_transitions` 仅设置目标页（`slides` 未指定时作用于全部页），未指定的页保留源转场。仅 `pptx_apply_plan` 默认注入 `fade` 转场（可通过 `transition` 参数覆盖，`transition: null` 表示保留源转场）。

### 工具 63–69：图片处理（`image_*`）

7 个工具，本地图片处理（Pillow，已嵌入运行时）。

| 工具 | 说明 |
|------|------|
| `image_info` | 读取尺寸/格式/模式/EXIF 方向 |
| `image_convert` | 格式转换（目标格式由输出扩展名决定） |
| `image_resize` | 缩放（fit/fill/pad/stretch，保持比例） |
| `image_compress` | 质量压缩 + 可选最大尺寸限制 |
| `image_rotate` | 任意角度旋转（`degrees` 可选，省略或 0 时仅做 EXIF 方向矫正） |
| `image_crop` | 像素坐标裁切 |
| `image_watermark` | 文字/图片水印（6 锚点 + tile 平铺，CJK 字体自动选择） |

---

## 架构

```
general-tools/
├── src/
│   ├── index.ts              # MCP 服务入口（工具注册、请求处理）
│   ├── md-converter.ts       # Markdown → HTML 渲染管线
│   ├── ocr-service.ts        # 百度 OCR 文字识别服务
│   ├── pdf-converter.ts      # Puppeteer PDF 转换核心
│   ├── pdf-extractor.ts      # LiteParse PDF 文本/截图提取
│   ├── pdf-postprocess.ts    # PDF 水印/二维码（pdf-lib）
│   ├── pdf-ops.ts            # PDF 合并/拆分/提取/压缩（纯 JS pdf-lib）
│   ├── pdf-service.ts        # PDF 加密/解密（PyMuPDF 子进程）
│   ├── pdf-tools.ts          # PDF 操作工具 schema 与 action 映射
│   ├── ppt-service.ts        # PPTX 读取/编辑（python-pptx 子进程）
│   ├── ppt-tools.ts          # PPTX 读取/编辑工具 schema 与 action 映射
│   ├── image-service.ts      # 图片处理（Pillow 子进程）
│   ├── image-tools.ts        # 图片处理工具 schema 与 action 映射
│   ├── html-to-docx.ts       # HTML → DOCX 转换器（docx npm 包）
│   ├── docx-service.ts       # DOCX 生成（纯 JS）+ 编辑（python-docx 子进程）
│   ├── docx-tools.ts         # DOCX/PDF 工具 schema 与 action 映射
│   ├── python-runner.ts      # Python 脚本执行器（PPT 相关工具底层）
│   ├── ppt-master-service.ts # PPT 生成、图片生成、Markdown 转换服务
│   └── types.ts              # TypeScript 类型定义
├── scripts/
│   ├── ppt-master/
│   │   └── scripts/          # ppt-master Python 脚本（svg_to_pptx 等）
│   │       ├── ppt_mcp/      # PPTX 读取/编辑子进程入口（run.py + reader/writer）
│   │       └── image_mcp/    # 图片处理子进程入口（run.py + ops + cjk_fonts）
│   ├── pdf/
│   │   ├── run.py            # PDF 加密/解密子进程入口（PyMuPDF）
│   │   └── pdf_ops.py        # PyMuPDF 加密/解密实现
│   └── docx/
│       ├── run.py            # DOCX 编辑子进程入口
│       └── docx_mcp/         # python-docx 编辑动作模块
├── sample.html
├── e2e-ppt-master.ts
└── dist/                     # 编译产物
```

**转换流程：**

```
Markdown → md-converter.ts → 完整 HTML（含样式/目录/Mermaid）
                                    ↓
                               pdf-converter.ts
                                    ↓
                                   PDF
```

---

## 系统要求

- **Node.js** 18+
- **npm** 9+
- **Python** 3.10+（PPT 相关工具需要，自动检测 python3.12/3.11/3.10）
- **内存** 最低 512MB，推荐 1GB+
- **Chromium**（PDF/图片转换用）：首次使用 `convert_to_pdf`/`convert_to_image` 前，运行一次安装命令（约 15 秒，缓存到 `~/.cache/puppeteer/`，之后跨重装复用）；或安装 Google Chrome 后自动兜底使用。已装 Chrome 的机器无需手动安装：

  ```bash
  # 安装 Chrome Headless Shell（国内加速走 npmmirror 镜像）
  npx puppeteer browsers install chrome-headless-shell \
    --base-url https://registry.npmmirror.com/-/binary/chrome-for-testing

  # 或直接用系统已装的 Google Chrome（无需上面命令）
  ```

### 中韩文/Emoji 字体（可选）

```bash
# macOS
brew install font-noto-sans-cjk
brew tap homebrew/cask-fonts
brew install font-noto-color-emoji

# Ubuntu / Debian
sudo apt-get install -y fonts-noto-cjk fonts-noto-color-emoji

# Amazon Linux / RHEL
sudo yum install -y google-noto-sans-cjk-kr-fonts google-noto-sans-serif-cjk-kr-fonts
sudo yum install -y google-noto-emoji-color-fonts

# 更新字体缓存
fc-cache -fv
```

---

## 性能参考

| 阶段 | 耗时 |
|------|------|
| 首次 PDF 生成（含浏览器启动） | ~1.5-2s |
| 后续转换（复用浏览器） | ~0.5-1s |
| 浏览器实例内存 | ~100-200MB |

---

## 技术细节

- **浏览器实例池**：单例模式，首次调用时启动 Chrome，后续复用
- **错误处理**：文件校验、超时控制、崩溃恢复、资源清理
- **图片嵌入**：根据 Markdown 所在目录解析相对路径，转为 data:image URI
- **Mermaid**：检测到代码块时自动加载 CDN JS 并渲染
- **OCR 服务**：
  - 输入优先级：image > url > pdf_file > ofd_file
  - 支持 PDF/OFD 文件识别，可指定页码
  - 支持 25+ 种语言识别
  - Token 缓存：access_token 有效期 30 天，提前 1 天自动刷新
  - 降级策略：高精度接口失败时自动降级到通用接口
  - 错误映射：百度 OCR 错误码自动翻译为中文提示

---

## License

MIT
