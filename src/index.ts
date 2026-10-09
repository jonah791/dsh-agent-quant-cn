/**
 * dsh-agent-quant-cn：国内市场量化系统的**工具面**。
 *
 * 它解决什么：数值层与协议层是验收过的资产，但住在**两个不同的解释器**里
 * （CTP 网关必须 Windows venv，回测必须 WSL venv），模型够不着。
 * 本插件把 CTP 那半暴露成工具：模型只管调 `quant_ctp_*`，
 * 参数校验、子进程、凭据取用、结果归一、可读呈现都在这一层。
 *
 * 架构（**为什么不是全 TS**）：
 *
 *     模型 → quant_ctp_*（本插件，TS）→ vault.ps1（取密）→ JSON CLI（Python）→ openctp-ctp
 *
 * 硬约束（写在这里，因为这是离执行最近的地方）：
 * - **只连模拟盘，不碰真钱**。真实下单必须主人逐次授权，且**不走本插件**。
 * - **凭据零落盘**：口令只在「取 → 注入子进程 env → 用完即弃」这条线上存在，
 *   不进配置、不进日志、不进工具返回；错误消息里**只带 stderr，绝不带 stdout**（stdout 是明文）。
 * - **不假装能力**：`ctp_quote` 不暴露（`mdapi` 在本 CLI 内会段错误），
 *   状态里如实披露行情通道不可用 —— 不把它包装成一个「看起来能用」的工具。
 * - **失败要响**：CLI 非零退出 / stdout 不是合法 JSON ⇒ 报错，
 *   不返回空结果冒充成功（空与失败是两件事）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawnSync } from 'node:child_process'
import {
  buildRequest,
  dropUndefined,
  parseCliReply,
  parseVaultValue,
  pickAccount,
  pickStatus,
  renderAccount,
  renderStatus,
  type CliReply,
} from './ctp.ts'

export const name = 'agent-quant-cn'
export const inject = ['tools'] as const

export interface Config {
  enabled: boolean
  /** CTP 解释器。**必须**是 Windows 侧 venv —— CTP 预编译库在 WSL 上 import 即崩。 */
  ctpPython: string
  /** JSON CLI 路径（Windows 视角）。 */
  ctpCliPath: string
  /** CTP 用户号。openctp 公开测试账号，**非密**（密的是口令，只从 vault 取）。 */
  ctpUser: string
  /** CTP 经纪商代码（openctp TTS 柜台为 9999）。 */
  ctpBroker: string
  /** vault 取值脚本（PowerShell + DPAPI）。 */
  vaultScript: string
  /** vault 里的站点条目名。 */
  vaultSite: string
  /** 单次调用的超时（ms）。CTP 登录 + 结算确认的实测耗时在 3–10 秒量级。 */
  timeoutMs: number
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  ctpPython: z.string().default('E:\\alice\\.dsh\\venvs\\ctp-win\\Scripts\\python.exe'),
  ctpCliPath: z.string().default('E:\\alice\\projects\\self\\agent-quant\\scripts\\ctp_cli.py'),
  ctpUser: z.string().default('20661'),
  ctpBroker: z.string().default('9999'),
  vaultScript: z
    .string()
    .default('E:\\alice\\projects\\self\\alice-identity\\scripts\\vault.ps1'),
  vaultSite: z.string().default('openctp-7x24'),
  timeoutMs: z.number().default(60_000),
})

/** 与 `scripts/ctp_cli.py` 的契约（三行，见那里 docstring）。 */
const CTP_CLI_CONTRACT = 'stdin=JSON{cmd,args} · stdout=JSON{ok,...} · stderr=诊断'

interface RunResult {
  reply: CliReply | null
  error: string | null
  ms: number
}

export function apply(ctx: Context, config: Config): void {
  // 只认 === false：未配置 / undefined 视为启用（避免把「没写」误判成「关掉」）
  if (config.enabled === false) return
  const logger = ctx.logger('agent-quant-cn')

  /**
   * 从 vault 取口令。
   *
   * ⚠ 错误消息**只带 stderr**：stdout 是明文口令，把它拼进错误会把凭据送进会话日志。
   * 这是本插件最容易被写错的一行 —— 修的时候先看这里。
   */
  function readSecret(): { value: string | null; error: string | null } {
    const p = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        config.vaultScript,
        'get',
        '-Site',
        config.vaultSite,
        '-Field',
        'password',
        '-Force',
      ],
      { encoding: 'utf-8', timeout: 30_000 },
    )
    if (p.error) return { value: null, error: `无法启动 powershell：${String(p.error)}` }
    if (p.status !== 0) {
      const err = (p.stderr ?? '').trim().slice(0, 300)
      return { value: null, error: `vault 退出码 ${p.status}：${err || '(stderr 为空)'}` }
    }
    try {
      return { value: parseVaultValue(p.stdout ?? ''), error: null }
    } catch (e) {
      return { value: null, error: String(e) }
    }
  }

  /** 跑一次 CTP CLI。**永不抛**：一切失败转成可读 error（观测不反噬）。 */
  function runCtp(cmd: string, args: Record<string, unknown>): RunResult {
    const started = Date.now()
    const secret = readSecret()
    if (secret.value === null) {
      return { reply: null, error: secret.error ?? 'vault 取密失败', ms: Date.now() - started }
    }
    try {
      const p = spawnSync(config.ctpPython, [config.ctpCliPath], {
        input: buildRequest(cmd, args),
        encoding: 'utf-8',
        timeout: config.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          CTP_USER_7X24: config.ctpUser,
          CTP_BROKER: config.ctpBroker,
          CTP_PWD_7X24: secret.value,
        },
      })
      const ms = Date.now() - started
      if (p.error) {
        return { reply: null, error: `无法启动解释器（${config.ctpPython}）：${String(p.error)}`, ms }
      }
      if (p.status !== 0 && (p.stdout ?? '').trim().length === 0) {
        const err = (p.stderr ?? '').trim().slice(0, 400)
        return { reply: null, error: `CLI 退出码 ${p.status}（无 stdout）：${err || '(stderr 为空)'}`, ms }
      }
      try {
        return { reply: parseCliReply(p.stdout ?? ''), error: null, ms }
      } catch (e) {
        return { reply: null, error: String(e), ms }
      }
    } catch (e) {
      return { reply: null, error: `调用 CTP CLI 异常：${String(e)}`, ms: Date.now() - started }
    }
  }

  ctx.tools.register(
    defineTool({
      name: 'quant_ctp_status',
      description:
        'CTP 模拟盘体检：交易前置登录 + 结算确认 + 资金与持仓。'
        + '这是「我方系统能否接上国内期货模拟环境」的判据工具。'
        + '⚠ 行情通道（mdapi）已知在 CLI 内段错误，故不暴露；行情数据请走回测侧（akshare）。'
        + `\n契约：${CTP_CLI_CONTRACT}`,
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            error: { type: 'string' },
            loggedIn: { type: 'boolean' },
            settled: { type: 'boolean' },
            accounts: { type: 'array' },
            positions: { type: 'array' },
            marketDataStatus: { type: 'string' },
            marketDataNote: { type: 'string' },
            detail: { type: 'string' },
            elapsedMs: { type: 'number' },
          },
        },
        render: (_a: unknown, v: unknown) => [
          { type: 'text', text: renderStatus(v as Record<string, unknown>) },
        ],
      },
      async execute() {
        const r = runCtp('ctp_status', {})
        if (!r.reply) {
          return dropUndefined({ ok: false, error: r.error ?? '未知原因', elapsedMs: r.ms })
        }
        if (r.reply.ok !== true) {
          return dropUndefined({
            ok: false,
            error: r.reply.error ?? 'CLI 回包 ok:false 但未给 error',
            elapsedMs: r.ms,
          })
        }
        logger.info(`quant_ctp_status: ok in ${r.ms}ms`)
        return dropUndefined({ ok: true, ...pickStatus(r.reply), elapsedMs: r.ms })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'quant_ctp_account',
      description:
        'CTP 模拟盘的资金与持仓明细（比 quant_ctp_status 更聚焦账户，不做连接体检）。'
        + `\n契约：${CTP_CLI_CONTRACT}`,
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            error: { type: 'string' },
            loggedIn: { type: 'boolean' },
            settled: { type: 'boolean' },
            accounts: { type: 'array' },
            positions: { type: 'array' },
            detail: { type: 'string' },
            elapsedMs: { type: 'number' },
          },
        },
        render: (_a: unknown, v: unknown) => [
          { type: 'text', text: renderAccount(v as Record<string, unknown>) },
        ],
      },
      async execute() {
        const r = runCtp('ctp_account', {})
        if (!r.reply) {
          return dropUndefined({ ok: false, error: r.error ?? '未知原因', elapsedMs: r.ms })
        }
        if (r.reply.ok !== true) {
          return dropUndefined({
            ok: false,
            error: r.reply.error ?? 'CLI 回包 ok:false 但未给 error',
            elapsedMs: r.ms,
          })
        }
        logger.info(`quant_ctp_account: ok in ${r.ms}ms`)
        return dropUndefined({ ok: true, ...pickAccount(r.reply), elapsedMs: r.ms })
      },
    }),
  )
}
