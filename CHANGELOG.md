# 更新日志

## 0.14.2

- 「监视串口」「烧录并监视串口」优先使用工程的 `monitor_speed`（如 image-link 的 460800），没有再回退到扩展设置 `embeddedEnv.baud`
- 修复 ESP8266 项目启动日志因默认 115200 显示乱码的问题

## 0.14.1

- 明确边界：插件仓库只包含插件源码/配置，`projects/`、`.venv/`、`.platformio/` 属于被管理的嵌入式工作区
- `.gitignore` / `.vscodeignore` 增加这三个目录的防御性忽略，并补充 ARCHITECTURE 说明

## 0.14.0

- 重构插件结构：`extension.ts` 只负责激活，新增 `workbench.ts`（状态/编排）、`commands.ts`（命令注册表）、`wizards.ts`（向导）、`features.ts`（功能处理器）
- 工程化：ESLint（flat config）+ Prettier + `.editorconfig`，新增 `npm run lint/format/check`
- 测试：新增 `test/activation-smoke.cjs`（用 stub 的 vscode API 加载 dist 并校验 29 个命令注册），接入 `npm run check`
- CI：`.github/workflows/ci.yml`（typecheck/lint/test/激活测试/build/VSIX 产物）和 `release.yml`（tag 发布）
- 文档：新增 `ARCHITECTURE.md`，README 增加架构与开发命令

## 0.13.5

- 删除「生成调试配置（launch.json）」命令、工程视图标题栏按钮和右键菜单入口
- 删除 `core/debug.ts` 及对应 smoke 测试（调试相关能力整体移除）

## 0.13.4

- 删除「调试（Debug，实验性）」命令及其启动调试会话的逻辑
- 保留「生成调试配置（launch.json）」命令（ESP32 环境生成 cppdbg 配置）

## 0.13.3

- 清理：删除不再使用的 `listSerialPorts` 串口枚举代码（设备扫描已由 `ports.ts` 统一实现）
- 清理：`install.ps1` 移除旧扩展 ID `local-dev.embedded-env-manager` 的历史迁移逻辑
- 清理：`activationEvents` 去掉冗余的 `onCommand:*`（VS Code 1.74+ 会为 contributed commands 自动生成）

## 0.13.2

- 恢复「版本」视图（PlatformIO / 各工程锁定状态），保留「版本体检」命令和刷新按钮

## 0.13.1

- 不再为 ESP8266 生成占位调试配置（无 JTAG，配置也用不了），避免「运行和调试」下拉框出现重复/无效条目
- 「生成调试配置」现在只为 ESP32 系列且已构建的环境写入 launch.json
- ESP8266 点「调试」时只提示不支持，不再写配置

## 0.13.0

- 删除「版本」视图，侧边栏只保留 工程 / 设备 / 缓存
- 版本锁定体检改为命令「版本体检」，结果输出到「统一嵌入式」面板
- 移除 versions 视图的标题栏刷新按钮和「打开相关文件」命令

## 0.12.2

- 精简右键菜单：去掉「打开源码」「调试」「打开 platformio.ini」
- 源码改用工程树里的「源码」分组点击打开；调试/生成配置在工程视图标题栏和命令面板；platformio.ini 仍可通过命令面板打开

## 0.12.1

- 生成调试配置时按平台选择 GDB（ESP32 用 esp32 工具链、ESP8266 用 lx106），避免多工具链时选错

## 0.12.0

- 新增「生成调试配置（launch.json）」：为所有已构建环境生成 VS Code 调试配置，出现在「运行和调试」下拉框
- ESP32 生成真实 cppdbg 配置；ESP8266 生成带 `(ESP8266 · 无 JTAG)` 标记的实验性占位配置（连接会失败，属预期）
- 工程视图标题栏新增生成调试配置按钮；ESP8266 点「调试」时也可选择“仍生成调试配置”

## 0.11.0

- 工程节点展开后新增「源码」分组：列出 `src/` 下所有源码文件（`main.cpp` 优先），点击直接打开
- 源码列表支持子目录、递归扫描；无源码时显示提示

## 0.10.1

- 工程视图：**单击工程节点直接打开源码**（优先 `src/main.cpp`，否则第一个 `.cpp/.c/.ino`）
- 新增「打开源码」命令；工程/环境右键菜单可用，`platformio.ini` 仍在右键菜单

## 0.10.0

- 新增实验性「调试（Debug）」命令：ESP32 环境生成 `.vscode/launch.json`（cppdbg），可选启动 VS Code 调试会话
- ESP8266 会明确提示不支持（无 JTAG、PlatformIO 无调试工具）
- 不会自动启动 OpenOCD 调试服务器（localhost:3333），连接可能失败；需要 ESP32 硬件 + `ms-vscode.cpptools`

## 0.9.0

- 新增「烧录并监视串口」：烧录成功后自动在同一终端打开串口监视，直接看到启动日志
- 工程 / 环境右键菜单、设备视图右键（烧录并监视到此设备）和命令面板均可使用
- 用 `; if ($LASTEXITCODE -eq 0)`（PowerShell）/ `&&`（cmd/bash）串接，烧录失败时不会启动监视

## 0.8.1

- 修复：只使用当前打开的工作区目录，**不再向上查找父目录**的 `projects/`
- 串口扫描只在包含 `projects/` 的嵌入式工作区执行；打开插件源码等普通目录时不再显示串口
- 打开子目录/插件目录时不会再看到父级工程

## 0.8.0

- 项目更名为 **Embedded Workbench**：扩展 `name` 改为 `embedded-workbench`，扩展 ID 随之变化（需卸载旧版后重装）
- 同步更新 README、安装脚本、生成工程模板中的名称
- 安装脚本会自动卸载旧扩展 ID `local-dev.embedded-env-manager`

## 0.7.0

- 完善扩展元数据：市场图标、关键词、横幅、可信工作区声明、`vscode:prepublish` 构建钩子
- README 增加功能/命令/环境要求说明，新增 CHANGELOG
- 新增「设备 / 缓存 / 版本」视图的空状态引导

## 0.6.0

- 自包含环境：「初始化环境（安装 PlatformIO）」命令在工作区创建 `.venv` 并安装锁定的 PlatformIO 6.2.0
- 不再依赖仓库根 `scripts/`、`requirements.txt`、`docs/`；工作区识别只要求 `projects/`
- 「版本」视图改为对比插件锁定的 PlatformIO 版本
- 新建工程生成的 README 改为插件操作指引

## 0.5.1

- 删除工程对占用目录的容错：自动关闭工作目录在该工程内的终端与编辑器标签，删除带重试与「重试」按钮

## 0.5.0

- 工程右键「删除工程」：二次确认 + 路径安全校验（只允许 `projects/` 一级目录且含 `platformio.ini`）

## 0.4.0

- 右键串口「用此设备新建工程」：esptool 识别芯片后按芯片型号 + Flash 大小筛选平台/板卡/框架

## 0.3.1

- 新建工程命令改为标题栏 ＋ 按钮；增加设备芯片识别（esptool）

## 0.3.0

- 新建工程向导：平台 → 板卡 → 框架，自动查询并锁定平台版本
- 「添加板卡环境」：给现有工程追加 `[env:*]`

## 0.2.1

- 增加 `onView` 激活与「打开统一嵌入式面板 / 扫描串口设备」命令

## 0.2.0

- 设备视图：串口扫描、VID/PID 芯片识别（CH340 / CP210x / FTDI / ESP32 内置 USB）

## 0.1.0

- 初始版本：工程 / 缓存 / 版本视图，构建、烧录、监视串口、状态栏
