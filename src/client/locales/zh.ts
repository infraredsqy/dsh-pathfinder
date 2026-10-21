/**
 * The panel's Simplified Chinese word lookup table — the key-set source of truth.
 *
 * Every word a reader of the panel can see lives here, and nowhere else: a component that prints
 * text asks for a key, never for a literal. This file states which keys exist; every other locale
 * is typed against it, so a missing or extra key is a compile error rather than a screen where one
 * word stays in the wrong language.
 *
 * Keys are flat and dotted, matching the shape DSH's own locale service registers (see
 * `@deepseek-ai/dsh-client-locale`). A `{name}` placeholder is substituted at call time; the
 * wording around it is free to move the placeholder anywhere, because word order differs between
 * languages.
 *
 * Two things deliberately do NOT live here: the records' own words (a node's title, a status the
 * tool wrote, a `pf config` value) and the console diagnostics this plugin prints for developers.
 * The first is data — it is shown verbatim in every language. The second is not interface text.
 */
export const zh = {
  /* ── The panel's identity ─────────────────────────────────────────────────────────────────── */
  'panel.title': '寻路',
  'seat.label': '调度中心',
  'settings.section': '寻路面板',

  /* ── When the panel has nothing to draw ───────────────────────────────────────────────────── */
  'panel.not-enabled': '当前工作区尚未启用 Pathfinder。',
  'panel.no-record': '当前工作区没有 pathfinder 的记录。',
  'panel.ungrouped-empty': '未分组名下没有记录；这条会话属于清单里的某个工作区。',
  'panel.unreadable': '无法读取当前工作区的记录。',
  'panel.no-session': '尚未选中会话，无法确定工作区。',

  /* ── The workspace selector ───────────────────────────────────────────────────────────────── */
  'workspace.aria': '工作区',
  'workspace.ungrouped': '未分组',

  /* ── The vocabulary of state ──────────────────────────────────────────────────────────────── */
  /* Five marks carry meaning on this panel: delivered / running / not started / waiting / failed.
   * These words are said in many places — a column head, a section head, a count pill, a hover —
   * and they are spelled once here so that all of them say the same thing. */
  'state.done': '已交付',
  'state.running': '进行中',
  'state.todo': '未开始',
  'state.shelved': '等待处理',
  'state.ready': '可开工',
  'state.next': '即将进线',
  'state.just-done': '刚完成',

  /* ── The human gate ───────────────────────────────────────────────────────────────────────── */
  /* A gate's own kind says which of these it is; the shelved gate reads as the shelved state, so
   * it reuses that word rather than saying a second thing for the same fact. */
  'gate.manual': '手动节点',
  'gate.checkpoint': '检查点',

  /* ── The four states an issue can sit in ──────────────────────────────────────────────────── */
  'issue.open': '未解决',
  'issue.acknowledged': '已承认',
  'issue.rejected': '已驳回',
  'issue.resolved': '已解决',

  /* ── The panel's own display controls ─────────────────────────────────────────────────────── */
  'info.lean': '精简',
  'info.three': '展开',
  'info.full': '铺满',
  'view.now': '当前',
  'view.detail': '明细',
  'view.notes': '指令',
  'view.wires': '依赖',
  'view.issue': '问题',
  'view.config': '设置',

  /* ── The settings section ─────────────────────────────────────────────────────────────────── */
  'settings.row.help': '{label}这一行管什么',
  'settings.info.label': '默认信息量',
  'settings.tab.label': '默认标签页',
  'settings.archived.label': '指令里显示已归档的',
  'settings.archived.tip': '归档的条目默认收起来：一屏里先看见现在还算数的。打开这一行，它们回到各自的段里，右边多一枚复原。',
  'settings.other-states.label': '问题池里显示未解决之外的',
  'settings.other-states.tip': '问题池那一格默认只画未解决的。打开这一行，已承认 / 已驳回 / 已解决 才回到页面上，各自收在自己的段里。',
  'settings.unavailable': 'DSH 还没把 {ns} 暴露成设置命名空间，这里的改动不会保存。',

  /* ── Words shared across the panes ────────────────────────────────────────────────────────── */
  'common.settings': '设置',
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.archive': '归档',
  'common.revive': '复原',
  'common.collapse': '收起',
  'common.unset': '未设置',
  'common.global': '全局',
  'common.expand-more': '展开其余 {count} 条',

  /* ── The board ────────────────────────────────────────────────────────────────────────────── */
  'board.per-column.aria': '每列几张卡',
  'board.card.aria': '{node} 的会话',

  /* ── The detail view ──────────────────────────────────────────────────────────────────────── */
  'detail.lines.aria': '线路',
  'detail.line.settings.aria': '{cycle} 的设置',
  'detail.side-grip.aria': '调整线路侧栏的宽度',
  'detail.folded.cells.one': ' 格',
  'detail.folded.cells.other': ' 格',
  'cycle.blocked': '阻塞',
  'cycle.running': '运行中',
  'cycle.stopped': '停止',

  /* ── The instruction ledger ───────────────────────────────────────────────────────────────── */
  'notes.scroll.aria': '用户指令',
  'notes.scope.node': '这一格 · {node}',
  'notes.scope.aria': '这句话管到哪儿',
  'notes.text.placeholder': '原话照抄',
  'notes.text.aria': '原话照抄',
  'notes.add': '添加',
  'notes.empty': '这份记录里还没有指令。',
  'notes.empty-live': '现在没有生效的指令。',
  'notes.in-force': ' 生效',
  'notes.entries.one': ' 条',
  'notes.entries.other': ' 条',
  'notes.out-of-scope': '范围外',
  'notes.archived-mark': '已归档',
  'notes.said-at': '说于',
  'notes.said-mark': '{mark}于',
  'notes.archive.tip': '收进归档：这一条不再生效，条目留在原处',
  'notes.revive.tip': '让它重新生效',
  'notes.delete.tip': '删掉：这一条连同正文一起从记录里拿走，放不回来',
  'notes.delete.name': '删除这一条',
  'notes.delete.warning': '此次删除将移除该指令的存在痕迹。',

  /* ── The issue pool ───────────────────────────────────────────────────────────────────────── */
  'pool.detail-level.aria': '问题池的详略',
  'pool.lean.tip': '{state} {count} 条',
  'pool.full': '完整',
  'pool.scroll.aria': '问题池',
  'pool.grip.aria': '问题池与一案的宽度',
  'pool.case.aria': '一案',
  'pool.weight.tip': '{severity} · 权重 {weight} · {title}',
  'pool.gauge.aria': '问题池重量与策略线',
  'pool.policy-line.tip': '策略线：issue_pool_weight_limit = {value}',
  'pool.severity.tip': '{severity} · 权重 {weight}',
  'pool.case.description': '现象',
  'pool.case.suggestion': '修法',
  'pool.case.locations': '位置',
  'pool.case.plan': '方案',

  /* ── Project settings ─────────────────────────────────────────────────────────────────────── */
  'config.toggle.on': '开',
  'config.toggle.off': '关',
  'config.grip.aria': '调整设置那一列的宽度',
  'config.unregistered-caption': '这一键还没有它的说法，值合不合法由工具判',
  'config.layer.default': '默认',
  'config.layer.project': '本项目',
  'config.row.worktree_mode.name': 'worktree 档',
  'config.row.worktree_mode.caption': '一格的活要不要开在自己的 worktree 里跑',
  'config.row.test_tier.name': '测试档',
  'config.row.test_tier.caption': 'full 跑整套测试套件，minimal 只跑项目自己的几条检查',
  'config.row.max_agents.name': '并行 subagent 上限',
  'config.row.max_agents.caption': '一个 session 同时在飞的 subagent 数量上限',
  'config.row.issue_repair.name': 'issue 开关',
  'config.row.issue_repair.caption': '问题池越线时自动加入解决问题的节点；关了就不自动加',

  /* ── A line's own policy numbers ──────────────────────────────────────────────────────────── */
  'line.row.parallel.name': '可并行的会话数上限',
  'line.row.parallel.note': '单条管线可以并行启动的会话数量，默认值为 1。',
  'line.row.test_seconds_limit.name': '测试套件的运行时间上限（秒）',
  'line.row.test_seconds_limit.note': '全量验证的实际时长上限阈值；超过该上限会自动加入精简或加速测试的节点。',
  'line.row.issue_pool_weight_limit.name': '问题池加权和的上限',
  'line.row.issue_pool_weight_limit.note': '问题池里不同等级的问题，按记录里写明的重量表折算出的总和上限阈值；超过该阈值会自动加入解决问题的节点。',

  /* ── The dependency field ─────────────────────────────────────────────────────────────────── */
  /* The owed-prerequisite sentence is asked for in two pieces, around the number: the panel styles
   * that number, and a language is free to put it first (see the English table, where the head
   * is empty). Splitting one finished sentence on the number would break the moment word order
   * moved. */
  'deps.owed.head': '前置节点 ',
  'deps.owed.tail': ' 个',
  'field.figures.columns.one': ' 列',
  'field.figures.columns.other': ' 列',
  'field.figures.nodes.one': ' 节点',
  'field.figures.nodes.other': ' 节点',
  'field.figures.edges.one': ' 边',
  'field.figures.edges.other': ' 边',
  'field.zoom-in.aria': '放大',
  'field.zoom-out.aria': '缩小',
  'field.zoom-reset.aria': '回到全图',
  'field.region.aria': '依赖全景',

  /* ── The reading marks shared by the panes ────────────────────────────────────────────────── */
  'marks.running.elapsed': '进行中 · {elapsed}',

  /* ── How a moment reads ───────────────────────────────────────────────────────────────────── */
  /* Which moment is "now" is decided once, on the fetch beat, and handed to these words; they take
   * the current time from the caller and never read a clock of their own. */
  'date.today': '今天',
  'date.yesterday': '昨天',
  'date.before-yesterday': '前天',
  'date.month-day': '{month}月{day}日',
  'duration.none': '没有记录',
  'duration.seconds': '{value} 秒',
  'duration.minutes': '{value} 分钟',
  'duration.hours': '{value} 小时',
  'duration.hours-minutes': '{value} 小时 {rest} 分',
  'ago.just-now': '刚刚',
  'ago.minutes': '{value} 分钟前',
  'ago.hours': '{value} 小时前',
  'ago.days': '{value} 天前',

  /* ── The scope of an instruction ──────────────────────────────────────────────────────────── */
  'scope.node': '这一格',

  /* ── When an operation is refused ─────────────────────────────────────────────────────────── */
  /* Each code from `src/host/failure.ts` and `src/client/failure.ts` reads as one of these.
   *
   * Two of them are the whole detail and nothing else: `tool-refused` and `transport-failed` carry
   * another program's words — the `pf` tool's own reason, or a message from the transport — and no
   * table here owns those. They are carried out verbatim, which is also why the panel can show
   * them in a language it does not speak; `failure.unstated` stands in when they said nothing. */
  'failure.arg-not-allowed': '该参数不能进入命令：{detail}',
  'failure.no-subprocess': '该宿主没有可用的进程通道，无法执行这次写入。',
  'failure.pf-missing': '未找到 pf 命令：{detail}',
  'failure.pf-path-unsafe': 'pf 命令的路径中含有 cmd 无法处理的字符（{detail}），无法执行这次写入。',
  'failure.no-interpreter': '这台机器上没有能把原话送进 pf 的解释器：`python` 与 `py` 都不在 PATH 上。',
  'failure.tool-refused': '{detail}',
  'failure.spawn-failed': '{detail}',
  'failure.scope-unknown': '无法识别的范围：{detail}',
  'failure.empty-text': '空话不落笔：先写一句原话。',
  'failure.policy-key-unknown': '无法识别的策略键：{detail}',
  'failure.no-operation': '这条通道上没有 {detail} 这个操作。',
  'failure.not-connected': '该部署未连接寻路记录服务，无法读取记录。',
  'failure.no-write-channel': '该部署没有可用的写入通道。',
  'failure.unparsable-answer': '宿主返回了无法解析的数据。',
  'failure.transport-failed': '{detail}',
  'failure.config-unreadable': '无法读取该工作区的项目设置。',
  'failure.config-write-failed': '这次写入没有生效。',
  'failure.settings-refused': '保存失败：设置服务没有接受这次改动。',
  'failure.settings-unwritable': '显示偏好未能保存：设置服务未连接，本次改动只在当前页面生效。',
  'failure.unstated': '这次操作没有成功，也没有说出原因。',
} as const

/**
 * Every key this panel can ask for.
 *
 * Derived from the table above rather than declared separately: one list, so a key cannot exist
 * in the type and be missing from the words. Every other locale is typed against this, which is what
 * makes a missing or extra key a compile error.
 */
export type WordKey = keyof typeof zh