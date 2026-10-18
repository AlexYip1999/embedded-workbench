# Embedded Workbench（统一嵌入式工作台）

把任意文件夹变成嵌入式工程目录：工程、设备、缓存都在这个面板里管理，
环境（Python + PlatformIO）也由扩展自己创建，不需要脚本或仓库模板。

- **工程**视图：扫描 `projects/*/platformio.ini`，展开后有「源码」分组（列出 `src/` 下源码，点击直接打开）和板卡环境（board/flash 提示）；单击工程节点打开入口源码，右键可删除工程、生成调试配置等；`platformio.ini` 用命令面板打开
- **设备**视图：扫描串口，显示 COM 口、描述、硬件 ID（VID/PID）和 USB 桥接芯片（CH340、CP210x、FTDI…）；右键「识别芯片（esptool）」可读出目标 MCU 型号（如 `ESP8266EX`）、Flash 大小、MAC 地址
- **缓存**视图：`.platformio/packages`、`platforms`、`.venv`、各工程 `.pio` 的体积
- **命令**：初始化环境 / 构建 / 烧录 / 监视串口 / 清理 / 切换当前环境 / 检查依赖更新 / 版本体检
- **状态栏**：当前工程环境 + PlatformIO 版本，点击可切换

设备视图中：

- 单击串口 = 用当前环境监视该串口
- 右键：烧录到此设备 / 识别芯片（esptool）/ **用此设备新建工程** / 监视此串口 / 复制端口名
- 「用此设备新建工程」：先识别芯片（如 `ESP8266EX · 4MB`），然后只列出与该芯片/Flash 匹配的平台、板卡和框架，创建后可直接构建并烧录到该串口
- 串口识别依据 `pio device list --json-output` 的 `hwid`（如 `USB VID:PID=1A86:7523` → CH340）
- 「识别芯片（esptool）」会复位板子并暂时占用串口，读回芯片型号、Flash 大小和 MAC；首次使用会提示安装 `tool-esptoolpy`（几 MB）

## 命令一览

| 命令 | 用途 |
| --- | --- |
| 初始化环境（安装 PlatformIO） | 首次使用/环境丢失时，在工作区创建 `.venv` 并安装锁定的 PlatformIO 6.2.0 |
| 新建 PlatformIO 工程（标题栏 ＋） | 向导选择平台 → 板卡 → 框架，生成工程并锁定平台版本 |
| 添加板卡环境 | 给现有工程追加 `[env:*]`，不动已有内容 |
| 构建 / 烧录 / 监视串口 / 清理 | 对当前环境或右键的工程/环境执行 |
| 烧录并监视串口 | 烧录成功后自动在同一终端打开串口监视，直接看启动输出 |
| 打开源码 | 打开工程入口源码（优先 `src/main.cpp`），单击工程节点即触发 |
| 打开 platformio.ini | 打开工程配置文件（命令面板） |
| 调试（Debug，实验性） | ESP32 环境生成 `cppdbg` 调试配置并尝试启动 VS Code 调试；ESP8266 提示不支持且不写配置 |
| 生成调试配置（launch.json） | 为 ESP32 且已构建的环境写入调试配置，出现在「运行和调试」下拉框 |
| 检查依赖更新 | 对所有工程运行 `pio pkg outdated`，输出到「统一嵌入式」面板 |
| 版本体检 | 检查 PlatformIO 版本、各工程 platform/lib_deps 是否锁版本，结果输出到「统一嵌入式」面板 |
| 识别芯片（esptool） | 读取串口设备的目标 MCU、Flash 大小、MAC |
| 用此设备新建工程 | 先识别芯片，再按芯片/Flash 筛选板卡创建工程，可直接构建并烧录 |
| 删除工程 | 二次确认后删除 `projects/<工程>`（安全校验路径） |
| 打开统一嵌入式面板 / 扫描串口设备 | 找不到活动栏图标时，从命令面板直达 |

## 环境（由扩展管理，无需脚本）

- 工作区打开任意文件夹即可；工程放在 `<工作区>/projects/<工程名>/`
- **只认当前打开的工作区目录，不会向上查找父目录**；打开不含 `projects/` 的普通目录时，工程/设备列表会显示说明而不是父级内容
- 需要 VS Code ≥ 1.90；「初始化环境」需要系统里有 Python 3.9+（用于创建 `.venv`）
- 首次使用运行命令面板 **「初始化环境（安装 PlatformIO）」**：
  - 在 `<工作区>/.venv` 创建 Python 虚拟环境
  - 安装 **PlatformIO Core 6.2.0**（版本由扩展锁定）
  - 之后所有 `pio` 命令都注入 `PLATFORMIO_CORE_DIR=<工作区>/.platformio`
- 环境或缓存丢失时，重新执行「初始化环境」即可重建
- 构建/烧录/监视都在 VS Code 终端里执行，首次构建会下载平台、工具链和框架（一次性）

## 新建工程向导

「工程」视图标题栏的 **＋** 按钮，或命令面板执行 **「新建 PlatformIO 工程」**：

1. 选择「新建工程」或「给现有工程添加环境」
2. 输入工程名（创建到 `projects/`）
3. 选平台：ESP8266 / ESP32 / STM32 / RP2040 / AVR / 其他（手动输入）
4. 选板卡：可输入过滤，显示 MCU / Flash / RAM / 框架（数据来自 `pio boards <平台> --json-output`）
5. 选框架：arduino / espidf / stm32cube / esp8266-rtos-sdk…
6. 确认摘要 → 生成 `platformio.ini` + `src/main.cpp` + `README.md`

平台版本会自动查询 PlatformIO registry 并写死（如 `espressif8266@4.2.1`）；查不到时提示首次构建后再锁定。
生成后自动刷新视图、设为当前环境，并询问是否立即构建（首次构建会下载工具链）。

## 调试（实验性）

- **仅 ESP32 系列可用**；ESP8266 没有 JTAG，PlatformIO 也不提供调试工具
- 命令会生成 `.vscode/launch.json`（`cppdbg`，GDB 路径自动从 `.platformio/packages/toolchain-*` 里查找）
- **不会自动启动 OpenOCD 调试服务器**（`localhost:3333`），没有调试服务器/硬件时连接会失败
- 需要 `ms-vscode.cpptools` 扩展；真机断点调试建议用 ESP32-C3/S3（内置 USB-JTAG）

## 构建（扩展开发）

```powershell
cd vscode-envgui
npm install
npm run typecheck
npm run build
npm run smoke      # 用真实工作区数据跑一遍核心逻辑（含串口扫描、向导、删除校验）
```

## 打包与本地安装

```powershell
.\install.ps1
# 等价于：npx @vscode/vsce package --allow-missing-repository --skip-license --no-dependencies
#         code --install-extension embedded-workbench-0.9.0.vsix --force
```

装完后在 VS Code 里 `Developer: Reload Window`，左侧活动栏会出现芯片图标。

## 设计约定

- 所有 pio 子进程都注入 `PLATFORMIO_CORE_DIR=<工作区>\.platformio`，不碰 `%USERPROFILE%\.platformio`
- 构建/烧录走 VS Code 终端（日志、Ctrl+C、错误输出免费复用）
- 只读优先：清理只调用 `pio run -t clean`；删除工程有路径安全校验
- 串口扫描只读：`pio device list --json-output`，不占用端口

## 常见问题

- **删除工程报 `EBUSY`**：目录被某个终端 / 串口监视 / 编辑器占用（Windows 不允许删除仍被进程占用的目录）。
  新版会先关闭工作目录在该工程内的 VS Code 终端、关闭相关编辑器标签，再带重试删除；
  如果仍失败，执行命令面板 `Terminal: Kill All Terminals`（终端: 终止所有终端），或关闭 VS Code 后再删除。
- **提示没有 PlatformIO**：运行命令面板「初始化环境（安装 PlatformIO）」，需要网络下载 Python 依赖。
