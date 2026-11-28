// The ticket and waiting-on-you flows (see flows.ts for the rules).
import type { Diagram } from './model'
import {
  AGENT,
  DEVICE,
  INITIATOR,
  RUNNER,
  STORE,
  WINDOWS,
  WSL,
  YOU,
} from './lanes'

export const ticketLife: Diagram = {
  id: 'ticket',
  title: { zh: '工单的生命周期', en: 'The ticket lifecycle' },
  summary: {
    zh: '在一个仓库里把活儿交给另一个仓库，后台 Agent 完成，需要你时停下来问。',
    en: 'Work handed from one repository to another, done by a headless agent that stops to ask when it needs you.',
  },
  numbered: true,
  lanes: [YOU, INITIATOR, STORE, RUNNER],
  cards: [
    {
      id: 'create',
      lane: 'initiator',
      title: { zh: '开单', en: 'File it' },
      sub: {
        zh: '从哪到哪、看到了什么、假设什么',
        en: 'From / to, what you saw, what you assume',
      },
      body: {
        zh: '在发起仓库里（或网页端）开单：目标仓库必须在白名单里，并写清看到的现象和假设，方便对方先核实。',
        en: 'Filed from the initiating repository (or the web console): the target must be allowlisted, and the ticket states what was seen and assumed so the other side checks it first.',
      },
      impl: {
        zh: 'ticket create；网页端是 ticket.new（ticket_new.go）。',
        en: 'ticket create; from the web console, ticket.new (ticket_new.go).',
      },
    },
    {
      id: 'record',
      lane: 'store',
      title: { zh: '记录', en: 'Recorded' },
      sub: { zh: '工单文件 + 事件', en: 'Ticket file + events' },
      body: {
        zh: '每次变化都追加一条事件，列表靠事件序号判断有没有变化。',
        en: 'Every change appends an event; lists use the event head to tell whether anything moved.',
      },
      impl: {
        zh: '_data/<id>/ticket.md、meta.json、events.jsonl；health.seq_head。',
        en: '_data/<id>/ticket.md, meta.json, events.jsonl; health.seq_head.',
      },
    },
    {
      id: 'research',
      lane: 'runner',
      title: { zh: '调研', en: 'Research' },
      sub: {
        zh: '在目标仓库里核实假设',
        en: 'Checks the assumptions in the target',
      },
      body: {
        zh: '后台 Agent 在目标仓库读代码、跑命令，先确认问题与方案。',
        en: 'The headless agent reads code and runs commands in the target repository to confirm the problem and the plan.',
      },
      impl: {
        zh: 'ticket run --phase auto，经 systemd-run 跑在独立单元里，relay 重启不受影响。',
        en: 'ticket run --phase auto in its own systemd-run unit, so a relay restart does not stop it.',
      },
    },
    {
      id: 'implement',
      lane: 'runner',
      title: { zh: '实现', en: 'Implement' },
      sub: {
        zh: '在工作树里改并验证',
        en: 'Changes and verifies in a worktree',
      },
      body: {
        zh: '改动在目标仓库的工作树里完成，并跑验证。',
        en: 'Changes land in a worktree of the target repository, with verification.',
      },
    },
    {
      id: 'ask',
      lane: 'store',
      title: { zh: '需要你', en: 'Needs you' },
      sub: { zh: '状态：等你', en: 'Status: waiting on you' },
      body: {
        zh: '遇到需要拍板的事，Agent 把问题写进讨论（可带选项），工单标为「等你」。',
        en: 'When a decision is needed the agent writes the question into the thread (with options if any) and marks the ticket as waiting on you.',
      },
    },
    {
      id: 'reply',
      lane: 'you',
      title: { zh: '回复', en: 'Reply' },
      sub: { zh: '网页端点选项或写一句', en: 'Tap an option or write a line' },
      body: {
        zh: '在网页端回复，选择「回复并继续」，后台 Agent 接着干。',
        en: 'Reply from the web console and choose Reply and continue; the headless agent carries on.',
      },
      impl: {
        zh: 'reply（签名写入）→ ticket reply --continue。',
        en: 'reply (a signed write) → ticket reply --continue.',
      },
    },
    {
      id: 'ship',
      lane: 'runner',
      title: { zh: '交付', en: 'Ship' },
      sub: { zh: '状态：已交付', en: 'Status: shipped' },
      body: {
        zh: '完成后工单进入「已结束」，过程和花费都留在运行记录里。',
        en: 'Done, the ticket moves to Ended; the runs keep the transcript and the cost.',
      },
    },
  ],
  links: [
    { from: 'create', to: 'record' },
    { from: 'record', to: 'research', kind: 'trigger' },
    { from: 'research', to: 'implement' },
    {
      from: 'implement',
      to: 'ask',
      kind: 'fallback',
      label: { zh: '需要决定时', en: 'when a decision is needed' },
    },
    { from: 'ask', to: 'reply', kind: 'trigger' },
    { from: 'reply', to: 'implement', label: { zh: '继续', en: 'continue' } },
    { from: 'implement', to: 'ship' },
  ],
}

export const waitingSignal: Diagram = {
  id: 'waiting',
  title: { zh: '「等你」信号怎么传开', en: 'How “waiting on you” spreads' },
  summary: {
    zh: '一个 hook 写下状态，网页优先呈现；打开完整终端时也能看到。',
    en: 'One hook records the state for the web console, with the full terminal display available when opened.',
  },
  numbered: true,
  lanes: [AGENT, WSL, WINDOWS, DEVICE],
  cards: [
    {
      id: 'hook',
      lane: 'agent',
      title: { zh: 'hook 触发', en: 'A hook fires' },
      sub: {
        zh: '本轮结束、要确认、在提问',
        en: 'Turn ended, needs a confirmation, asks',
      },
      body: {
        zh: 'Claude、Codex、Grok 的 hook 在状态变化时报告。',
        en: 'Claude, Codex and Grok hooks report when their state changes.',
      },
      impl: {
        zh: 'scripts/runtime 下的 attention hook；安装见 docs/agent-attention.md。',
        en: 'The attention hooks under scripts/runtime; install in docs/agent-attention.md.',
      },
    },
    {
      id: 'state',
      lane: 'wsl',
      title: { zh: '写入会话状态', en: 'Write the state' },
      sub: { zh: 'attention.json', en: 'attention.json' },
      body: {
        zh: '记下会话在哪个窗格、现在什么状态、在等什么。',
        en: 'Records the session’s pane, its status and what it waits for.',
      },
    },
    {
      id: 'badge',
      lane: 'windows',
      title: { zh: '完整终端状态', en: 'Full terminal status' },
      sub: { zh: '按需打开时', en: 'When opened' },
      body: {
        zh: '使用完整 WezTerm 配置时，标签和状态栏也会显示等待状态。',
        en: 'The full WezTerm configuration can also show waiting status in tabs and the status bar.',
      },
    },
    {
      id: 'list',
      lane: 'wsl',
      title: { zh: '会话列表', en: 'Session list' },
      sub: { zh: '等你的排最前', en: 'Waiting ones first' },
      body: {
        zh: 'relay 读同一份状态，网页端的会话列表把等你的会话放在最上面。',
        en: 'The relay reads the same record; the web console lists sessions that wait on you first.',
      },
    },
    {
      id: 'webseen',
      lane: 'device',
      title: { zh: '网页端看到', en: 'Seen in the web console' },
      sub: { zh: '会话标签计数', en: 'A count on the Sessions tab' },
      body: {
        zh: '会话标签上出现计数，打开就是那条会话；可以直接回答选项或按键。',
        en: 'The Sessions tab shows a count; open it and answer the options or keys right there.',
      },
    },
    {
      id: 'push',
      lane: 'device',
      planned: true,
      title: { zh: '推送提醒', en: 'Push notification' },
      sub: { zh: '规划中', en: 'Planned' },
      body: {
        zh: '计划用 Web Push 在手机、平板锁屏时提醒「等你」与失败。',
        en: 'Planned: Web Push for waiting-on-you and failures while a phone or tablet is locked.',
      },
    },
  ],
  links: [
    { from: 'hook', to: 'state' },
    { from: 'state', to: 'badge', kind: 'data' },
    { from: 'state', to: 'list', kind: 'data' },
    { from: 'list', to: 'webseen' },
    { from: 'list', to: 'push', kind: 'fallback' },
  ],
}
