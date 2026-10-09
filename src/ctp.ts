/**
 * 纯层：请求构造 / 回包解析 / 字段挑选 / 文本呈现。
 *
 * 为什么不写在 index.ts：这些是**不碰 I/O 的判定逻辑** ⇒ 可以离线单测；
 * index.ts 只留「注册工具 + 起子进程 + 装配结果」。见技能 `dsh-plugin-testability`。
 *
 * 契约（与 `projects/self/agent-quant/scripts/ctp_cli.py` 对齐）：
 *   stdin  = JSON{cmd, args}
 *   stdout = JSON{ok:true, ...} 或 JSON{ok:false, error}
 *   stderr = 诊断
 */

/** CLI 回包：`{ok: true, ...}` 或 `{ok: false, error}`；其余字段随命令而异。 */
export interface CliReply {
  ok: boolean
  error?: string
  [key: string]: unknown
}

/**
 * 递归剔除 `undefined`（含嵌套对象与数组）。
 *
 * ⚠ 必须深入数组：`JSON.stringify([1, undefined, 3])` 得到 `[1,null,3]`——
 * undefined 被**静默 null 化**，「字段没给」于是变成「字段是 null」，宿主的严格 schema 会拒。
 * 同形态实现见 `self-plugins/dsh-agent-quant/src/engine.ts`；跨插件不 import（§5.34 禁读别人内部），
 * 故各自持有一份 —— 上游若改这条语义，这里要跟。
 */
export function dropUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((v) => v !== undefined).map((v) => dropUndefined(v)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[k] = dropUndefined(v)
    }
    return out as unknown as T
  }
  return value
}

/** 构造 stdin。**总是**带 `args`（即使为空对象）—— 契约两侧都读它。 */
export function buildRequest(cmd: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ cmd, args: dropUndefined(args) })
}

/**
 * 解析 CLI stdout 里的结果 JSON。
 *
 * 从**后往前**逐行找：CLI 当前只在最后打一行 JSON，但从后往前找是稳健做法
 * （将来它加一行诊断输出不会打断解析）。
 *
 * ⚠ 「解析失败」与「回包 ok:false」是**两件事**：前者是契约破裂（该给的结果没给），
 * 后者是业务失败（连不上前置 / 凭据被拒）。调用方必须分开处置，不得都归成「调用失败」。
 */
export function parseCliReply(stdout: string): CliReply {
  const lines = stdout.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim()
    if (line.length === 0 || !line.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as CliReply
      }
    } catch {
      // 这一行不是 JSON —— 继续往前找，不代表整段 stdout 坏了
    }
  }
  throw new Error(`stdout 里没有 JSON 结果（前 200 字符：${stdout.slice(0, 200) || '(空)'}）`)
}

/**
 * `vault.ps1 get` 的 stdout 解析。
 *
 * 空值**必须响亮失败**：取不到东西却返回成功，会让下游以一个看不出原因的登录失败告终，
 * 排查方向从一开始就偏了。空与拿到是两件事。
 */
export function parseVaultValue(stdout: string): string {
  const value = stdout.replace(/[\r\n]+$/, '').trim()
  if (value.length === 0) throw new Error('vault 返回空值（空 ≠ 拿到）')
  return value
}

/** 从 `ctp_status` 回包里挑字段。缺席的一律给 undefined，由 dropUndefined 清掉。 */
export function pickStatus(reply: CliReply): Record<string, unknown> {
  const trading = asObject(reply.trading) ?? {}
  const market = asObject(reply.market_data) ?? {}
  return {
    loggedIn: asBool(trading.logged_in),
    settled: asBool(trading.settled),
    accounts: asArray(trading.accounts),
    positions: asArray(trading.positions),
    marketDataStatus: asString(market.status),
    marketDataNote: asString(market.note),
    detail: asString(trading.error) ?? reply.error,
  }
}

/** 从 `ctp_account` 回包里挑字段。 */
export function pickAccount(reply: CliReply): Record<string, unknown> {
  return {
    loggedIn: asBool(reply.logged_in),
    settled: asBool(reply.settled),
    accounts: asArray(reply.accounts),
    positions: asArray(reply.positions),
    detail: reply.error,
  }
}

/**
 * 行渲染：**按对象自身的键**列出，不猜字段名。
 *
 * 为什么不用固定列：账户与持仓的字段名归 `ctp_cli.py` 所有，这里写死一份就会漂移
 * （上游加字段，这儿静默看不见）。通用渲染换来「上游改字段也照样显示全」。
 */
function renderRows(rows: unknown[], max = 20): string[] {
  const out: string[] = []
  for (const row of rows.slice(0, max)) {
    const o = asObject(row)
    if (o === null) {
      out.push(`  · ${String(row)}`)
      continue
    }
    const parts: string[] = []
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === undefined || v === '') continue
      parts.push(`${k}=${formatScalar(v)}`)
    }
    out.push(`  · ${parts.join('  ') || '(无字段)'}`)
  }
  if (rows.length > max) out.push(`  … 另有 ${rows.length - max} 条未显示`)
  return out
}

function formatScalar(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  return String(v)
}

/**
 * 从回包里取出「这次为什么失败」。
 *
 * 两个来源是**两件事**，只认其一时另一类失败会变成屏幕上**没有原因的 ✗**：
 * - 顶层 `error` —— 调用/契约层面的失败（起不来进程、退出码非零、stdout 不是 JSON）
 * - `detail` —— 业务层面的失败（连不上前置、凭据被拒），由 pickStatus/pickAccount 从 `trading.error` 提取
 *
 * ⚠ 2026-10-09 现场尸体测试抓到的就是这个：把 `ctpCliPath` 指向不存在的文件，
 * 工具回 `{ok:false, error:"CLI 退出码 2…"}`，而屏幕只显示「登录 ✗ · 结算确认 ✗」——原因整条丢失。
 */
function pickReason(v: Record<string, unknown>): string | null {
  for (const key of ['error', 'detail']) {
    const raw = v[key]
    if (typeof raw === 'string' && raw.length > 0) return raw
  }
  return null
}

/** `ctp_status` 的可读呈现。 */
export function renderStatus(v: Record<string, unknown>): string {
  const reason = pickReason(v)
  const lines: string[] = []
  if (v.ok === false) {
    // 连「登录 / 结算」都没走到 ⇒ 不摆那两个 ✗（摆了也不给原因，读数就没有指向）
    lines.push(`CTP 模拟盘体检：调用失败 ✗ —— ${reason ?? '(未给原因)'}`)
    return lines.join('\n')
  }
  const accounts = asArray(v.accounts)
  const positions = asArray(v.positions)
  lines.push(
    `CTP 模拟盘体检：登录 ${v.loggedIn === true ? '✓' : '✗'} · 结算确认 ${v.settled === true ? '✓' : '✗'}`,
  )
  if (reason !== null) lines.push(`失败原因：${reason}`)
  lines.push(`资金账户 ${accounts.length} 条 · 持仓 ${positions.length} 条`)
  lines.push(...renderRows(accounts))
  if (positions.length > 0) {
    lines.push('持仓：')
    lines.push(...renderRows(positions))
  }
  if (v.marketDataStatus !== undefined && v.marketDataStatus !== null) {
    lines.push(`⚠ 行情通道：${String(v.marketDataStatus)}（本工具面不暴露行情工具，原因见其说明）`)
  }
  return lines.join('\n')
}

/** `ctp_account` 的可读呈现。 */
export function renderAccount(v: Record<string, unknown>): string {
  const reason = pickReason(v)
  const lines: string[] = []
  if (v.ok === false) {
    lines.push(`CTP 模拟盘账户：调用失败 ✗ —— ${reason ?? '(未给原因)'}`)
    return lines.join('\n')
  }
  const accounts = asArray(v.accounts)
  const positions = asArray(v.positions)
  lines.push(
    `CTP 模拟盘账户：登录 ${v.loggedIn === true ? '✓' : '✗'} · 结算确认 ${v.settled === true ? '✓' : '✗'}`,
  )
  if (reason !== null) lines.push(`失败原因：${reason}`)
  lines.push(`资金 ${accounts.length} 条：`)
  lines.push(...renderRows(accounts))
  lines.push(`持仓 ${positions.length} 条：`)
  lines.push(...renderRows(positions))
  return lines.join('\n')
}

/* ── 类型守卫：形状归一先于取值（外部对象不得直接 .length / [0]）───────────── */

function asObject(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return null
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
