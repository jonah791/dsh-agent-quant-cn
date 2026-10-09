# dsh-agent-quant-cn · 语义文档

> 元信息：版本 v0.1 · 状态 verified（build 0 · typecheck 0 · 纯层单测 **22/22** · vault 取密前置实测可用 · CTP CLI 端到端实测 `logged_in:true` · **挂载后线上真调通过** · **失败路径与回退路径均现场取证**）· 最近复核 2026-10-09 · owner agent-quant-cn

## 1 · 定位与反定位

**是什么**：把**国内期货模拟盘（CTP）**的账户侧能力**暴露成模型可调用的工具**。它是「工具面」的**第二个实例**——第一个是加密线的 `dsh-agent-quant`（同形态、不同市场、不同运行时、无代码耦合）。

**不是什么**（反定位）：

- **不是引擎本体**——数值层与协议层在 `projects/self/agent-quant`（Python），本插件一行 CTP 都不实现
- **不是回测工具**——回测在 WSL venv 的 `aq` 包；本插件只转发 CTP 那半（**两个解释器，故必须分家**，见 §5）
- **不是行情工具**——`ctp_quote` **故意不暴露**（`mdapi` 在该 CLI 内段错误），行情走回测侧 akshare
- **不是下单工具**（v0.1）——当前只有「体检 / 账户」两件；**报单能力尚未存在**
- **不是 A 股工具**——A 股侧按合规判据只做「研究 + 信号」，本插件不碰 A 股任何接口
- **不是自足可分发的 npm 包**——依赖本机 Windows venv + vault + 固定引擎路径（见 §5）

## 2 · 术语表

| 术语 | 含义 |
|---|---|
| **CTP** | 上期技术综合交易平台；国内期货的标准交易/行情 API |
| **openctp** | CTP 的第三方兼容实现（本项目用它连模拟盘，免开户） |
| **TTS 柜台** | openctp 提供的模拟柜台。⚠ openctp 的库只能连 TTS；用官方 CTP 库连它会报 **4097** |
| **JSON CLI** | Python 侧的对外面：stdin 一个 JSON、stdout 一个 JSON、诊断走 stderr（`scripts/ctp_cli.py`） |
| **纯层** | `src/ctp.ts`——不碰 I/O 的判定逻辑（请求构造 / 回包解析 / 字段挑选 / 呈现），可离线单测 |
| **体检（status）** | 一次调用里同时判定：交易前置登录 + 结算确认 + 资金与持仓 ⇒ 「我方能否接上国内期货模拟环境」的判据动作 |
| **结算确认（settled）** | CTP 登录后必须完成的结算单确认；未确认则查不到资金 ⇒ 它是「登录成功」之后**第二道**门，两者不可混同 |
| **KNOWN_BLOCKER** | 已知且已定位范围但**未修**的缺口。用它标记行情通道，是为了**不把它包装成「可用」** |
| **段错误码 0xC0000005** | Windows 访问违例。本项目里它是 `mdapi` 在 CLI 进程内的失败指纹 |

## 3 · 概念模型与不变量

```
模型 → quant_ctp_*（本插件：校验 + 取密 + spawn + 归一 + 呈现）
      → vault.ps1（DPAPI 取口令）
      → ctp_cli.py（Windows venv，Python）
      → openctp-ctp → TTS 柜台（模拟盘）
```

不变量（违反即缺陷）：

1. **凭据零落盘**：口令只在「vault 取 → 注入子进程 env → 用完即弃」这条线上存在。不进配置、不进日志、不进工具返回。
2. **错误消息只带 stderr，绝不带 stdout**：`vault.ps1` 的 stdout 就是**明文口令**——把它拼进错误消息等于把凭据送进会话日志。这是本插件**最容易被写错的一行**。
3. **空 ≠ 拿到**：vault 返回空值必须**响亮失败**。空口令冒充成功，会让下游以一个看不出原因的登录失败告终，排查方向从一开始就偏了。
4. **两类失败必须分开**：`stdout 里没有 JSON`（**契约破裂**——该给的结果没给）与 `回包 ok:false`（**业务失败**——连不上前置 / 凭据被拒）是两件事，不得都归成「调用失败」。
5. **永不抛到工具层**：子进程失败、超时、解析失败一律转成 `{ok:false, error}` 可读文案（观测不反噬）。
6. **`ok` 必须是布尔**：CLI 回包缺 `ok` 或类型不对 ⇒ 解析器抛错（不允许「缺字段当 false」这种含糊）。
7. **输出必须过 `dropUndefined`（含数组）**：`JSON.stringify` 会把 `undefined` 静默 null 化成 `null` ⇒ 「字段没给」变成「字段是 null」，宿主严格 schema 拒收。
8. **不假装能力**：行情通道不可用就**如实披露**（`marketDataStatus = KNOWN_BLOCKER` + 原因），不提供「看起来能用」的行情工具。
9. **渲染按对象自身的键，不猜字段名**：账户/持仓的字段名归 `ctp_cli.py` 所有；这里写死一份，上游加字段就静默看不见。
10. **形状归一先于取值**：外部对象不得直接 `.length` / `[0]`——先过类型守卫。

## 4 · 契约

### 4.1 配置（Config schema）

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 只认 `=== false`；未配置视为启用 |
| `ctpPython` | string | `E:\alice\.dsh\venvs\ctp-win\Scripts\python.exe` | **必须**是 Windows 侧 venv（CTP 预编译库在 WSL 上 import 即崩） |
| `ctpCliPath` | string | `E:\alice\projects\self\agent-quant\scripts\ctp_cli.py` | JSON CLI 路径（Windows 视角） |
| `ctpUser` | string | `20661` | openctp 公开测试账号，**非密**（密的是口令，只从 vault 取） |
| `ctpBroker` | string | `9999` | 经纪商代码（openctp TTS 柜台） |
| `vaultScript` | string | `E:\alice\projects\self\alice-identity\scripts\vault.ps1` | 取值脚本（PowerShell + DPAPI） |
| `vaultSite` | string | `openctp-7x24` | vault 里的条目名 |
| `timeoutMs` | number | `60000` | 单次调用超时（CTP 登录 + 结算确认实测 3–10 秒量级） |

⚠ **路径是锚点不是真源**（AGENTS.md §5.16）：换机 / 换 venv 位置改配置，不改代码。

### 4.2 工具面

**`quant_ctp_status`** — 无参数。返回 `{ok, loggedIn?, settled?, accounts?, positions?, marketDataStatus?, marketDataNote?, detail?, elapsedMs, error?}`。
`accounts` / `positions` 透传 CLI 原形状（本插件不加字段、不改字段名）。

**`quant_ctp_account`** — 无参数。返回同上但**不含** `marketData*`；语义是「聚焦账户，不做连接体检」。

两者的 `render` 都按对象自身的键逐行列出；失败时文本里带原因。

### 4.3 调用点清单 [MUST]

| 调用点 | 位置 | 说明 |
|---|---|---|
| **模型直接调用** `quant_ctp_status` / `quant_ctp_account` | 工具面 | 唯一入口 |
| 依赖 `tools` service | `src/index.ts` 的 `apply` | `inject = ['tools']`；`ctx.tools.register` |
| **取密**：`powershell.exe -File vault.ps1 get -Site <vaultSite> -Field password -Force` | `readSecret()` | 每次调用都取一次（不缓存）。`-Force` 是 vault 对**秘密字段**的显式闸门，非可选 |
| **外部进程** Windows python + `ctp_cli.py` | `runCtp()` | `spawnSync`，即起即收，不驻留；**不在宿主进程树里长留** |
| 凭据注入面：env `CTP_USER_7X24` / `CTP_BROKER` / `CTP_PWD_7X24` | `runCtp()` 的 `env` | 口令只走 env，**不进 argv**（argv 在进程列表里可见） |
| JSON CLI 契约 | `scripts/ctp_cli.py`（仓库外） | `stdin=JSON{cmd,args}` · `stdout=JSON{ok,...}` · `stderr=诊断` |
| 挂载点 | `.dsh/profiles/web/cordis.patch.yml` 的 `id: agent-quant-cn` | 回退 = 该行 `disabled: true`（配置热重载约 2 秒，无需重启） |

## 5 · 边界与信任

- **输入信任级**：两个工具**都无参数** ⇒ 无用户可控的注入面。这是当前形态的**有意选择**（下单类工具一旦有参数，注入面立刻出现）。
- **能力边界（capability ≠ 沙箱）**：插件与宿主**同进程**，却 spawn 外部进程 ⇒ 那个 python **不受宿主沙箱约束**。它拿到的是 env 里的口令与固定脚本路径。
- **为什么必须有两个解释器**（本插件存在的理由）：CTP 的预编译库**必须 Windows venv**（WSL 侧 import 即崩），回测栈（numba / pandas）在 WSL venv。模型只有一个进程，够不着另一边 ⇒ 工具面这一层是必需的，不是装饰。
- **凭据边界**：vault 是 DPAPI 加密，**绑定当前 Windows 用户与机器**——换用户/换机即解密失败（退出码 3）。本插件**不持有**任何凭据副本。
- **依赖诚实声明**：**不自足**。依赖 ① Windows venv `ctp-win`（Python 3.12 + `openctp-ctp` 6.7.11 + 已 `openctp-channels switch tts`）② vault 文件与条目 ③ 引擎仓路径。缺任一项 ⇒ 工具报可读错误（错误文案里写清缺哪个）。
- **错误文案里出现的 python 路径可能不是 `ctpPython`**——**这不是配错了**：Windows venv 的 `python.exe` 是**重定向器**，真正跑起来的是基础解释器（本机实测：报出 `C:\Users\tr\scoop\apps\python312\current\python.exe`，而配置值是 `…\ctp-win\Scripts\python.exe`）。诊断时别据此判定「加载了错误的解释器」，判据是**能否 import openctp-ctp**，不是路径字符串。
- **硬约束（写在代码注释里，因为那是离执行最近的地方）**：**只连模拟盘，不碰真钱**；真实下单必须主人逐次授权，且**不走本插件**。
- **A 股侧显式不做**：按 2026-10-09 查到的合规判据（**合法 = 指令在券商可控沙箱内生成；体系外生成再送进来即违规**），「本机进程生成指令 → 送进券商终端」属被点名形态 ⇒ A 股侧定位为**研究 + 信号生成**，不做自动执行。正本：`docs/reports/a-share-quant-2026-10.md` §2.5。

## 6 · 与既有机制的关系

- 与 **`dsh-agent-quant`（加密线）**：**同形态、无耦合**。两者各持有一份 `dropUndefined`（§5.34 禁读别人内部 ⇒ 不跨插件 import）；上游若改这条语义，两处要跟。
- 与 **引擎仓 `projects/self/agent-quant`**：本插件是 CTP 那半的**唯一对外面**；引擎仓不感知 DSH 存在（只认 JSON CLI）。
- 与 **`projects/self/agent-quant/docs/plugin-design-quant.md`**：设计草案；**本文件是该插件契约的单一真源**，设计草案只作沿革。
- 与 **任务板 / 记忆**：无直接关系；量化任务进度仍走任务板。
- 与 **`dsh-agent-quant` 之外的其它插件**：无关系。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据 | 状态 |
|---|---|---|---|
| A1 | 编译零错误 | `node node_modules/typescript/bin/tsc -p tsconfig.json` → exit 0 | 已实测 |
| A2 | 类型检查零错误 | 上式加 `--noEmit` → exit 0 | 已实测 |
| A3 | 纯层单测 **22/22**（含 7 具尸体样本） | `node --test tests/ctp.test.mjs` → pass 22 / fail 0 | 已实测 |
| A4 | vault 取密前置可用 | `powershell -File vault.ps1 get -Site openctp-7x24 -Field password -Force` → exit 0，stdout 非空（只量长度，不落值） | 已实测 |
| A5 | **CTP CLI 端到端可跑**（依赖真的通，不是「我认为通」） | `'{"cmd":"ctp_status","args":{}}' \| python ctp_cli.py`（env 注入口令）→ exit 0；回包 `ok:true · trading.logged_in:true · trading.settled:true · accounts[0].balance:10000000.0 · positions[0].instrument:rb2701` | 已实测 |
| A6 | 行情通道如是标记，不当成可用 | A5 同一回包 `market_data.status:"KNOWN_BLOCKER"` 且 `note` 写明段错误码与已排除假设 | 已实测 |
| A7 | 挂载进 profile，线上真调成功 | 重启后调 `quant_ctp_status` ⇒ 首行「登录 ✓ · 结算确认 ✓」· `资金账户 1 条 · 持仓 1 条` · `balance=10000000 available=10000000` · `instrument=rb2701` · `KNOWN_BLOCKER` | 已实测 |
| A8 | 回退是配置级、可秒级生效 | patch 该行加 `disabled: true` ⇒ **23 秒后**工具从工具面消失（回 `unknown tool`），**全程无重启**；撤掉该行后 **19 秒**恢复绿 | 已实测 |
| A9 | 尸体·CLI 路径腐化 ⇒ 可读错误而非空结果 | 把 `ctpCliPath` 指向不存在文件 ⇒ 首行「CTP 模拟盘体检：**调用失败 ✗ —— CLI 退出码 2（无 stdout）**：…can't open file 'E:\alice\_tmp_review\definitely-nonexistent-ctp-cli.py': [Errno 2] No such file or directory」。⚠ **修前这条判据不通过**（只显示「登录 ✗」，原因整条丢失）——见 §9 | 已实测 |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（工具注册 + 取密 + 子进程）· `src/ctp.ts`（纯层，8 个导出）
- 测试：`tests/ctp.test.mjs`（18 例，含 4 具尸体样本）
- 同语义副本：无
- 引擎侧实现（另一仓）：`E:\alice\projects\self\agent-quant`（`scripts/ctp_cli.py` 是契约的另一半）
- 挂载点：`E:\alice\.dsh\profiles\web\cordis.patch.yml`

## 9 · 实践修订记录

- **2026-10-09 首次实现**。沿革：交付形态由主人当天定调为「DSH 插件（TS 工具面）+ Python 数值层 + JSON CLI 契约」；本项目此前是独立 Python 项目。
- 架构决策：**不把 CTP 逻辑重写成 TS**——它是 `openctp-ctp` 的胶水，重写等于重造协议实现；采用「薄转发」。
- 实现中修的三处（都是**踩过才写的**）：
  1. `output.schema` 写成变量 ⇒ **TS2322**（`type` 被推断成 `string` 而非字面量 `"object"`）⇒ **必须内联**（吃上下文类型）。
  2. pnpm 11 把 `peerDependencies` 装成**真副本**，遮蔽宿主 `E:\alice\node_modules\@deepseek-ai` ⇒ 加 `pnpm-workspace.yaml` 的 `autoInstallPeers: false` 后重装，`node_modules` 只剩 `@types` + `typescript`。⚠ **`.npmrc` 无效**（两种键名实测均无效）。
  3. `plugin_create` 骨架缺 4 件：`cordis.patch.yml` / `dsh-plugin.json` / `.gitignore` / `pnpm-workspace.yaml`（58 个既有插件全有）⇒ 记为 `plugin-manager` 可改进点。
- **2026-10-09 挂载后现场尸体测试抓出一处真缺陷（已修）**——**这条只因为「拿真坏样本喂线上」才存在**：
  - **症状**：把 `ctpCliPath` 指向不存在的文件，工具回 `{ok:false, error:"CLI 退出码 2…"}`，而屏幕上**只有**「登录 ✗ · 结算确认 ✗ / 资金账户 0 条 · 持仓 0 条」——**失败原因整条丢失**。
  - **根因**：渲染只认 `detail`（业务失败，来自 `trading.error`），不认顶层 `error`（调用/契约失败）⇒ 两类失败被混成一件，其中一类没有出口。**纯层单测当时全绿**——因为旧用例只喂了 `detail` 那条路径（`renderStatus 在失败时给出原因`），**没喂 `{ok:false}` 那条**。
  - **修法**：新增 `pickReason()` 统一取因（`error` 优先、`detail` 兜底）；`ok === false` 时首行改为「调用失败 ✗ —— 原因」并**不再摆**那两个 ✗（摆了也不给原因，读数就没有指向）。
  - **纪律**：先写 4 条判据（RED 3/22）→ 改实现 → GREEN 22/22 → 重建 lib → 重启 → **用同一个坏样本复验线上**。⇒ 判据见 §7 A9。
  - **元教训**：「单测全绿」与「失败路径有出口」是两件事——**绿只证明喂过的样本被满足**（§5.9 规则 5）。本项目今后新增渲染分支，必须同时喂「调用失败」与「业务失败」两类尸体。
- **故意不做**：`ctp_quote` 不暴露（段错误未定位，见 §10 U1）——**宁可少一个工具，不给一个会崩的工具**。

## 10 · 未决问题

- **U1 `mdapi` 段错误未定位**（exit `0xC0000005`）：同一台机器、同一份库，`scripts/probe-openctp-ctp.py` 能正常收 tick，而 `ctp_cli.py` 内不行。**已排除**：spi 强引用（已加）、`RegisterFront`/spi 调用顺序（已对调）。**未排除**：管道式 stdin 与交互式运行的差异、模块级类 vs 函数内闭包类的差异。**当前决定**：不为它继续烧时间——行情走 akshare。⇒ 若将来要行情，先复现这条二分。
- **U2 `spawnSync` 阻塞事件循环**：不接 `exec.signal`，长任务只能靠超时。当前两工具都是秒级，问题未显；**下单类工具进来前必须改成异步 spawn**。
- **U3 路径全部硬编码在缺省值里**：符合「本机专用」定位，但换机要改 3 个键。是否改成「包内相对路径解析」未决——那需要把引擎随包分发，与「引擎是独立仓」冲突。
- **U4 口令每调用一次取一次**：不缓存（安全性优先）。CTP 高频调用场景下 vault 调用会成为延迟项；是否需要「会话级短时缓存 + 显式失效」未决。
- **U5 A 股侧形态**：合规判据下「信号系统 + 人工执行」是唯一路线，但**人工执行**这一步的契约（信号如何送到人手上、如何记录执行结果）尚未设计。
