# dsh-agent-quant-cn

国内市场量化系统的**工具面**：把 CTP 模拟盘的操作暴露成会话内可直接调用的 DSH 工具。

它自己不实现任何策略或连接逻辑——那些在 `projects/self/agent-quant/`（Python 数值层 + JSON CLI）。
本插件只做「工具面 → 取凭据 → CLI → Python」这一层薄转发。

## 能力（工具）

| 工具 | 作用 | 底层 |
|---|---|---|
| `quant_ctp_status` | CTP 模拟盘体检：交易前置登录 + 结算确认 + 资金与持仓 | `ctp_cli.py ctp_status` |
| `quant_ctp_account` | 资金与持仓明细（不做连接体检） | `ctp_cli.py ctp_account` |

**故意不提供 `ctp_quote`（行情）**：`mdapi` 在该 CLI 内会段错误（0xC0000005，见任务板 `t-d6ac0958`）。
状态回包里如实披露 `market_data.status = KNOWN_BLOCKER`，不把它包装成一个看起来能用的工具。
行情数据请走回测侧（akshare）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 只认显式 `false`——未配置视为启用 |
| `ctpPython` | `E:\alice\.dsh\venvs\ctp-win\Scripts\python.exe` | **必须**是 Windows 侧 venv |
| `ctpCliPath` | `E:\alice\projects\self\agent-quant\scripts\ctp_cli.py` | JSON CLI |
| `ctpUser` | `20661` | openctp 公开测试账号（**非密**） |
| `ctpBroker` | `9999` | openctp TTS 柜台 |
| `vaultScript` | `E:\alice\projects\self\alice-identity\scripts\vault.ps1` | 取值脚本（DPAPI） |
| `vaultSite` | `openctp-7x24` | vault 条目名 |
| `timeoutMs` | `60000` | 单次调用超时 |

⚠ **路径是锚点不是真源**（AGENTS.md §5.16）：换机、换 venv 位置时改配置，不要改代码。

## 运行环境

- **CTP 必须跑 Windows venv**（`ctp-win`：Python 3.12 + `openctp-ctp` 6.7.11，已 `openctp-channels switch tts`）。
  CTP 预编译库在本机 WSL 上 import 即崩，且 openctp 用的是 TTS 柜台——直接用官方 CTP 库连会报 4097。
- **凭据零落盘**：口令只在「vault 取 → 注入子进程 env → 用完即弃」这条线上存在。
  不进配置、不进日志、不进工具返回；错误消息里**只带 stderr，绝不带 stdout**（stdout 是明文）。
  取不到时**响亮失败**（空 ≠ 拿到）——空口令冒充成功会让下游以看不出原因的登录失败告终。

## 生效判据

挂载后在会话里直调 `quant_ctp_status`，应返回真实读数：
`ok=true` / `loggedIn=true` / `settled=true`，且 `accounts` 含非空资金字段。

| 症状 | 先看哪里 |
|---|---|
| `vault 退出码 2` | vault 文件不存在 |
| `vault 退出码 3` | DPAPI 解密失败（换用户/换机器即如此） |
| `vault 返回空值` | 条目存在但没有 `password` 字段 |
| `无法启动解释器` | `ctpPython` 路径腐化 |
| `CLI 退出码 6` | 凭据未注入到 CLI（env 变量名对不上） |
| `login 3` | 柜台拒绝——用户名或口令不对 |

## 回退

改 `E:\alice\.dsh\profiles\web\cordis.patch.yml`：把该插件行的 `disabled` 置 `true`（配置改动约 2 秒热重载，无需重启）。

## 边界（不可协商）

- **只连模拟盘，不碰真钱**。真实下单必须主人逐次授权，且**不走本插件**。
- 不做策略、不做回测、不下单——这些能力在 Python 层，本插件不复制它们。
