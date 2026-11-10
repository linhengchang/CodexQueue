# CodexQueue

**把多个开发需求交给 Codex CLI，自动排队执行，完成后统一查看代码、决策与 Review 清单。**

CodexQueue 是一个本地可视化开发任务调度工具，桌面窗口名称为 **Auto Work**。通过表单管理任务，立即运行或每天定时执行；每个任务在独立 Git worktree 中完成规划、编码、校验和自查。

适合一次配置 2～3 个相互独立的页面或组件需求，运行期间自主处理普通技术选择，之后由你人工审核和合入代码。

> 这是需要本地 Node.js、Git 和 Codex CLI 的源码项目，不是免安装应用。当前已在 macOS 验证；Windows 适配已实现，尚未实机验证。

[安装与启动](#安装与启动) · [怎么使用](#怎么使用) · [功能清单](#功能清单) · [需求与设计](docs/requirements.md) · [详细使用说明](docs/usage.md)

## 功能清单

| 功能 | 说明 |
| --- | --- |
| 可视化任务管理 | 新增、编辑、删除任务，配置任务名称、Git 分支名和原始开发需求 Prompt |
| 图片需求 | 选择图片、拖拽、粘贴截图；预览和移除附件；PNG/JPEG/WebP；每任务最多 8 张，每张 10 MB |
| 立即 / 定时执行 | 一键启动批次，或设置每天固定时间运行；配置和记录持久化 |
| Git worktree 隔离 | 每任务独立分支与目录；整个批次固定基准提交；保留原工作目录和暂存区 |
| 并发与超时 | 默认并发 2、上限 5；默认单任务超时 60 分钟；任务异常不取消其他任务 |
| 登录预检查 | 复用本机 Codex 登录；页面打开、批次启动前检查登录状态 |
| 自主决策 | 优先沿用项目规范，再参考官方推荐和成熟常见做法；普通细节不向用户中途提问 |
| 规划 → 编码 → 校验 → Review | 自动保存方案、实施结果、真实校验退出码、遗留事项和人工检查点 |
| 实时进度与日志 | 查看各任务阶段、状态、方案、Review 和日志，支持取消批次 |
| 存储管理 | 查看图片、日志、验证截图、报告及配置索引占用，清理未引用图片和历史批次 |
| 桌面窗口 | 打开窗口启动服务，关闭窗口停止服务与运行任务；保留代码和历史结果 |

## 环境要求

- **Node.js 20 或更新版本**，以及配套 npm。
- **Git**，目标业务项目必须是已经存在提交的 Git 仓库。
- **Codex CLI**，需支持 `exec`、`--sandbox`、`--json`、`--image`、`--ephemeral` 和 `--output-schema`。
- 业务项目使用的包管理器与必要环境，例如 pnpm、npm 或 Yarn。
- 运行模型请求和安装依赖所需的网络环境，以及可用的 Codex 账号权限和额度。

安装或更新 Codex CLI：

```bash
npm install -g @openai/codex@latest
codex --version
codex login
codex login status
```

如果已经登录，直接检查状态即可。浏览器里登录了 ChatGPT，并不代表 Codex CLI 已经登录。详见 [OpenAI 官方 CLI 说明](https://learn.chatgpt.com/docs/codex/cli) 和 [认证说明](https://learn.chatgpt.com/docs/auth)。

## 安装与启动

### 1. 获取项目并安装依赖

macOS 终端或 Windows PowerShell：

```bash
git clone https://github.com/linhengchang/CodexQueue.git
cd CodexQueue
npm ci
```

### 2. 打开桌面窗口

所有平台均可在项目目录执行：

```bash
npm start
```

启动入口会先检查并构建前后端，再打开桌面窗口。桌面模式使用随机本机端口，服务仅绑定 `127.0.0.1`。

**macOS 双击启动：**

- 安装依赖后，可以双击项目根目录的 **启动面板.command**。
- 如果希望从访达直接打开 `.app`，先安装 Xcode Command Line Tools，再编译原生启动器：

```bash
# 仅未安装 Xcode Command Line Tools 时需要
xcode-select --install

# 安装完成后，在项目根目录执行
npm run build:launcher
```

之后双击 **Auto Work.app** 即可。启动器按当前 Mac 的芯片架构编译，生成的可执行文件不提交到仓库；其他 Mac 需要自行构建。`.app` 依赖项目目录，请保留整个目录，不要只移动 `.app`。

**Windows 双击启动：**

安装依赖后，双击 **启动面板.bat**，或在 PowerShell 中执行：

```powershell
.\启动面板.bat
```

建议初次使用 Windows 时，先用一个小任务验证 Codex、Git、包管理器和业务项目的运行环境。

### 3. 关闭应用

关闭桌面窗口或退出应用，会取消运行中的任务、终止其子进程、停止定时调度并释放端口；正常退出可能需要数秒。代码修改、方案和运行记录会保留。

**定时任务需要应用窗口保持打开、电脑保持开机且不休眠。** 下次启动恢复未来的调度，不补跑关闭期间错过的任务。

## 怎么使用

1. **选择项目**：选择业务项目的 Git 仓库根目录，点击 **检查项目**，确认基准提交与未提交修改提示。
2. **配置执行**：设置基准分支或提交、并发数量、超时；模型留空时沿用本机 Codex 配置。
3. **新增任务**：点击 **新增任务**，填写任务名称、Git 分支名、原始开发需求 Prompt，可添加设计图或截图。
4. **确认校验**：在 **运行配置** 中填写校验命令，每行一条；可自动检测现有 typecheck/lint 脚本。没有可用校验命令时会标记失败，不会直接算完成。
5. **保存并运行**：保存任务后点击 **保存配置**，或直接点击 **立即运行**。也可进入 **定时运行**，点击 **设置每日定时**。
6. **查看结果**：在 **运行记录** 中查看进度、真实校验结果、工作目录与分支，以及方案、Review 和日志。
7. **人工合入**：在对应 worktree 内检查、测试并提交修改，再自行合入目标分支。

**立即运行** 和 **设置每日定时** 会同时保存当前配置。运行中的批次使用配置快照；之后修改表单，不会改变已启动的批次。普通表单修改需要显式保存。

任务需求示例：

```text
沿用项目现有的表格和表单组件，实现用户列表筛选。
支持按名称和状态筛选、重置筛选条件，以及空数据、加载和错误状态。
按钮文案严格使用：查询、重置。
普通技术选择自行决定，完成后在 Review 中说明决策和遗留事项。
```

校验命令示例（使用业务项目实际存在的脚本）：

```text
pnpm run typecheck
pnpm run lint
```

## 自动执行是怎么工作的

```mermaid
flowchart LR
  A[登录与项目检查] --> B[独立 worktree]
  B --> C[只读规划]
  C --> D[准备依赖并编码]
  D --> E[后端独立校验]
  E --> F[只读 Review]
  F --> G[保留代码和报告]
```

- **规划**使用只读沙箱，后端保存 `plan.md`。
- **编码**使用 `workspace-write` 沙箱，将原始需求、方案与参考图片一起交给 Codex，记录实施摘要、决策和未完成事项。
- **校验**由后端独立执行，使用真实退出码，不以模型描述代替验证。
- **Review**区分已完成功能、已实现待复核决策、真正未完成事项与未验证内容。
- 普通技术选择的优先级是：**项目已有规范和实现 → 官方推荐用法 → 成熟常见做法 → 满足需求的简单实现**。
- 用户具体文案按原文保留。缺失、冲突或无法辨认的文案不自行编造，记录为待确认，继续可独立完成的部分。
- 使用临时 CLI 会话减少额外会话文件积累；面板自己的日志与报告仍保留。图片会在任务执行时发送给模型。

不会绕过 Codex 沙箱或权限限制。缺少必要权限、凭据或关键需求，仍可能导致任务失败或阻塞；报告会说明原因。当前版本不包含自动修复所有校验失败的重试循环。

## Git worktree 会影响原项目提交吗

各 worktree 拥有独立工作目录和暂存区。你在原目录的修改、`git add` 和提交，不会自动混入任务目录；任务也从已提交的基准开始，**不会包含原目录尚未提交的修改**。

worktree 共用仓库历史和分支引用。工具给每个任务创建唯一分支，不自动提交、推送、合并或清理业务代码。完成后代码以未提交修改保留在对应 worktree，需要人工审核后自行提交和合入。最终合入时仍可能遇到代码冲突。

## 图片、截图和存储清理

| 内容 | 保存位置（相对项目根目录） |
| --- | --- |
| 配置与历史 | `data/state.json` |
| 上传、拖拽、粘贴的图片 | `data/attachments/<内容哈希>.<扩展名>` |
| 开发方案与实施结果 | `task/<批次ID>/<任务ID>/` |
| 约定的验证截图 | `task/<批次ID>/<任务ID>/screenshots/` |
| 执行与错误日志 | `task/<批次ID>/<任务ID>/events.log`、`error.log` |
| Review 清单 | `todo/<批次ID>/<任务ID>/todo-review.md` |
| 清理后保留的代码目录索引 | `data/worktree-records/<批次ID>.json` |
| 开发代码 | 业务仓库同级 `.auto-work-worktrees/<仓库名>/<批次ID>/<任务ID>/` |

在 **存储管理** 中可查看占用和打开目录：

- 相同图片按内容去重，配置仅保存引用。
- 清理未引用图片时，保护已保存任务、保留历史批次和当前任务表单的图片。
- 清理历史批次时，移走日志、验证截图和报告，并移除对应运行记录；**保留 worktree、Git 分支和开发代码**。
- 桌面版把文件移入系统废纸篓，**清空废纸篓后才真正释放空间**。浏览器调试模式使用 `data/recycle-bin/`，文件仍占磁盘，需自行移除。
- 运行任务期间不允许清理。
- Codex 自身的聊天附件、登录凭据、依赖和 worktree 占用不包含在面板清理范围内。

工具会要求任务把验证截图放到约定目录；另存其他位置的文件不会自动纳入统计。导出配置 JSON 不包含图片文件本身，迁移电脑需要同时保留图片目录与状态文件。

## 项目结构

```text
CodexQueue/
├── desktop/             Electron 桌面窗口与 Swift 启动器源码
├── server/              登录检查、任务执行、调度、存储与 HTTP API
├── shared/              前后端共享类型与默认配置
├── web/                 React 面板
├── scripts/             启动、开发和 Mac 启动器构建脚本
├── tests/               临时仓库、模拟 Codex、进程与接口集成测试
├── docs/                需求与详细使用说明
├── Auto Work.app/       Mac 原生启动器元数据，需自行编译可执行文件
├── 启动面板.command     Mac 双击入口
├── 启动面板.bat         Windows 双击入口
└── package.json
```

技术栈：React、TypeScript、Vite、Express、Electron、node-schedule、Codex CLI。

## 本地开发与测试

```bash
npm run dev             # 后端 3080 + Vite 5173
npm run build           # 前后端类型检查与生产构建
npm test                # 构建并执行集成测试
npm run build:launcher  # 仅 macOS，编译原生 .app 入口
```

开发模式在终端按 `Ctrl+C` 停止前后端；桌面模式通过关闭窗口停止服务。

自动化测试使用临时仓库和模拟 Codex，不调用真实模型。已覆盖并发隔离、原暂存区保留、登录拦截、取消和恢复、校验状态、定时去重、接口访问控制、图片传递与清理保护。真实模型开发任务和 Windows 实机验证不在当前测试结论内。

## 常见问题

**找不到 Codex 或未登录？**

先在启动应用的同一系统用户下执行 `codex --version`、`codex login status`。确认 `PATH`、`CODEX_HOME` 和凭据存储环境一致，再重新打开应用。面板不会另存账号密码。

**登录检查通过，为什么任务仍失败？**

登录检查只确认凭据状态，不验证模型权限、网络和剩余额度。到运行记录查看阶段日志与错误原因。

**Codex 参数不支持？**

更新 Codex CLI，并用 `codex exec --help` 检查环境要求列出的参数。项目不使用旧的 `--full-auto` 参数。

**依赖或校验失败？**

确认业务项目使用的包管理器已安装、锁文件有效、校验脚本存在。自动依赖安装默认禁用生命周期脚本；需要原生编译、代码生成或本地配置的项目，应明确补充准备步骤。Yarn 等工具的不同主版本可能需要调整安装方式。

**Electron 下载失败？**

先检查网络或代理，重试安装。确实需要使用镜像时，可自行选择可信镜像；例如 macOS 终端：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci
```

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm ci
```

如果依赖已安装但 Electron 二进制缺失，检查包管理器是否禁用了安装脚本，再重新安装或运行 `npm rebuild electron esbuild`。

**Mac 双击启动失败？**

先在终端执行 `npm start` 查看错误。需要原生 `.app` 时执行 `npm run build:launcher`；双击入口日志在项目根目录的 `data-launch.log`。不要单独移动 `.app`。

**文件已经清理，磁盘空间没减少？**

检查系统废纸篓或浏览器调试模式的本地回收目录。worktree 与其依赖仍保留，可能比图片占用更多空间，需要人工审核后另行处理。

## 文档

- [需求、功能范围与执行设计](docs/requirements.md)
- [详细使用与实现说明](docs/usage.md)
- [验证范围](VERIFICATION.json)
- [OpenAI 官方认证说明](https://learn.chatgpt.com/docs/auth)
- [OpenAI 官方非交互模式说明](https://learn.chatgpt.com/docs/non-interactive-mode)
- [OpenAI 官方 CLI 参数说明](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
