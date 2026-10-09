/**
 * 纯层离线测试 —— 不需要 CTP、不需要网络、不需要凭据。
 *
 * 为什么这些能测：`lib/ctp.js` 里全是**不碰 I/O 的判定逻辑**（构造 / 解析 / 挑选 / 渲染）。
 * 真正的 I/O（起 powershell、起 python）在 `index.ts` 的 `runCtp` 里，那部分靠端到端验收。
 *
 * 纪律：每类判据都配**尸体样本**——只证明「好样本能过」不叫测试，
 * 得证明「坏样本真的会被拦」才有区分力（AGENTS.md §5.9 规则 2）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRequest,
  dropUndefined,
  parseCliReply,
  parseVaultValue,
  pickAccount,
  pickStatus,
  renderAccount,
  renderStatus,
} from '../lib/ctp.js'

/* ── buildRequest ───────────────────────────────────────────────────────── */

test('buildRequest 总是带 args —— 契约两侧都读它', () => {
  assert.equal(buildRequest('ctp_status'), '{"cmd":"ctp_status","args":{}}')
})

test('buildRequest 清掉 undefined 参数，而不是让它们变成 null', () => {
  const s = buildRequest('ctp_account', { instrument: 'rb2701', ticks: undefined })
  assert.equal(s, '{"cmd":"ctp_account","args":{"instrument":"rb2701"}}')
  assert.equal(s.includes('null'), false)
})

/* ── dropUndefined ──────────────────────────────────────────────────────── */

test('dropUndefined 深入对象', () => {
  assert.deepEqual(dropUndefined({ a: 1, b: undefined }), { a: 1 })
})

test('dropUndefined 深入数组 —— 这是本函数存在的唯一理由', () => {
  // 反例（不动数组的朴素实现）：JSON.stringify([1, undefined, 3]) === '[1,null,3]'
  // 「字段没给」于是变成「字段是 null」，宿主的严格 schema 会拒。
  const naive = JSON.stringify([1, undefined, 3])
  assert.equal(naive, '[1,null,3]', '前提：JS 确实会静默 null 化 —— 若此断言变了，本测试要重写')

  const cleaned = dropUndefined([1, undefined, 3])
  assert.deepEqual(cleaned, [1, 3])
  assert.equal(JSON.stringify(cleaned).includes('null'), false)
})

test('尸体样本：不清数组的实现必须被这条判据抓住', () => {
  /** 朴素实现（只清顶层键）—— 故意留的坏样本，证明上面的判据有区分力。 */
  function naiveDrop(value) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = v
    }
    return out
  }
  const input = { list: [1, undefined, 3] }
  assert.deepEqual(dropUndefined(input), { list: [1, 3] })
  assert.notDeepEqual(naiveDrop(input), { list: [1, 3] }, '坏样本必须与好实现不同，否则判据无区分力')
})

/* ── parseCliReply ──────────────────────────────────────────────────────── */

test('parseCliReply 解析单行 JSON 结果', () => {
  const r = parseCliReply('{"ok":true,"logged_in":true}')
  assert.equal(r.ok, true)
})

test('parseCliReply 允许结果前面有诊断行', () => {
  const r = parseCliReply('warming up...\nstill warming\n{"ok":false,"error":"login 3"}\n')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'login 3')
})

test('尸体样本：没有 JSON 时必须抛，不得返回空对象冒充成功', () => {
  assert.throws(() => parseCliReply('nothing here'), /stdout 里没有 JSON 结果/)
  assert.throws(() => parseCliReply(''), /stdout 里没有 JSON 结果/)
})

test('尸体样本：JSON 数组不是合法回包（回包必须是对象）', () => {
  assert.throws(() => parseCliReply('[1,2,3]'), /stdout 里没有 JSON 结果/)
})

/* ── parseVaultValue ────────────────────────────────────────────────────── */

test('parseVaultValue 去掉尾部换行', () => {
  assert.equal(parseVaultValue('s3cret\r\n'), 's3cret')
})

test('尸体样本：空值必须响亮失败（空 ≠ 拿到）', () => {
  assert.throws(() => parseVaultValue(''), /vault 返回空值/)
  assert.throws(() => parseVaultValue('\n\n'), /vault 返回空值/)
})

test('parseVaultValue 不改变口令中间的空格', () => {
  assert.equal(parseVaultValue('  a b  \n'), 'a b')
})

/* ── pickStatus / pickAccount ───────────────────────────────────────────── */

/** `ctp_cli.py ctp_status` 的真实回包形状（2026-10-09 读源码所得）。 */
const STATUS_REPLY = {
  ok: true,
  market_data: { status: 'KNOWN_BLOCKER', note: 'mdapi 段错误' },
  trading: {
    logged_in: true,
    settled: true,
    accounts: [{ Balance: 10000000.0, Available: 9999999.0 }],
    positions: [],
    error: null,
  },
}

test('pickStatus 从真实形状里挑出字段', () => {
  const v = pickStatus(STATUS_REPLY)
  assert.equal(v.loggedIn, true)
  assert.equal(v.settled, true)
  assert.equal(v.marketDataStatus, 'KNOWN_BLOCKER')
  assert.equal(v.accounts.length, 1)
})

test('pickStatus 对畸形回包不抛（韧性优先于报错）', () => {
  const v = pickStatus({ ok: true, trading: '不是对象', market_data: 42 })
  assert.equal(v.loggedIn, undefined)
  assert.deepEqual(v.accounts, [])
})

test('pickAccount 从真实形状里挑出字段', () => {
  const v = pickAccount({ ok: true, logged_in: true, settled: true, accounts: [], positions: [] })
  assert.equal(v.loggedIn, true)
  assert.deepEqual(v.positions, [])
})

/* ── 渲染 ───────────────────────────────────────────────────────────────── */

test('renderStatus 列出对象自身的键，不猜字段名', () => {
  const text = renderStatus(pickStatus(STATUS_REPLY))
  assert.match(text, /登录 ✓/)
  assert.match(text, /结算确认 ✓/)
  // 字段名归 ctp_cli.py 所有 —— 这里必须原样透出 Balance，不得硬编码成「余额」
  assert.match(text, /Balance=10000000/)
  assert.match(text, /KNOWN_BLOCKER/)
})

test('renderStatus 在失败时给出原因', () => {
  const text = renderStatus({ loggedIn: false, settled: false, accounts: [], positions: [], detail: 'login 3: 不合法的登录' })
  assert.match(text, /登录 ✗/)
  assert.match(text, /login 3/)
})

test('renderAccount 陈列资金与持仓两段', () => {
  const text = renderAccount({ loggedIn: true, settled: true, accounts: [{ Balance: 1 }], positions: [] })
  assert.match(text, /资金 1 条/)
  assert.match(text, /持仓 0 条/)
})

/* ── 渲染的失败路径（2026-10-09 现场尸体测试抓到的缺陷）─────────────────────
 * 缺陷现场：把 `ctpCliPath` 指向不存在的文件 ⇒ 工具回 `{ok:false, error:"CLI 退出码 2…"}`，
 * 而屏幕上只显示「登录 ✗ · 结算确认 ✗ / 资金账户 0 条 · 持仓 0 条」—— **原因整条丢失**。
 * 根因：渲染只认 `detail`（业务失败），不认顶层 `error`（调用/契约失败）⇒ 两件事被混成一件。
 * 下面两条是回归判据；末尾那条是尸体样本，证明判据有区分力。
 * ─────────────────────────────────────────────────────────────────────────── */

test('尸体样本·调用失败：`{ok:false,error}` 渲染必须给出原因，不得只显示「登录 ✗」', () => {
  const corpse = { ok: false, error: 'CLI 退出码 2（无 stdout）：No such file or directory', elapsedMs: 812 }
  const text = renderStatus(corpse)
  assert.match(text, /CLI 退出码 2/)
  assert.match(text, /No such file or directory/)
})

test('尸体样本·调用失败：renderAccount 同病同治', () => {
  const corpse = { ok: false, error: '无法启动解释器（E:\\x\\python.exe）：spawn ENOENT', elapsedMs: 5 }
  const text = renderAccount(corpse)
  assert.match(text, /无法启动解释器/)
  assert.match(text, /ENOENT/)
})

test('尸体样本：只认 detail 的坏实现必须被这条判据抓住（证明判据有区分力）', () => {
  /** 修前的实现（只读 `detail`）—— 故意留的坏样本。 */
  function naiveRender(v) {
    const lines = [`登录 ${v.loggedIn === true ? '✓' : '✗'}`]
    if (v.detail !== undefined && v.detail !== null) lines.push(`失败原因：${String(v.detail)}`)
    return lines.join('\n')
  }
  const corpse = { ok: false, error: 'CLI 退出码 2（无 stdout）：No such file or directory' }
  assert.equal(naiveRender(corpse).includes('CLI 退出码 2'), false, '坏样本必须与好实现不同，否则判据无区分力')
  assert.equal(renderStatus(corpse).includes('CLI 退出码 2'), true)
})

test('业务失败（ok:true + detail）的旧行为不许被这次修复改坏', () => {
  const text = renderStatus({ loggedIn: false, settled: false, accounts: [], positions: [], detail: 'login 3: 不合法的登录' })
  assert.match(text, /登录 ✗/)
  assert.match(text, /login 3/)
})
