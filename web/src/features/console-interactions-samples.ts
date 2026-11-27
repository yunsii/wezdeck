// Sample data for 交互调试 (console-interactions.tsx): one of each special
// interaction the session page renders, fed to the real components.
import type { Message } from './chat-thread'
import type { Elicitation } from './session-elicitation'
import type { PendingCall } from './session-permission'
import type { BgTask } from './session-background'
import type { GitDetail } from './session-git'
import type { WorkstationDirection } from './session-worktree-manager'

export const STATUS_WORKTREE_PATHS = {
  primary: '/workspace/wezdeck',
  agent: '/workspace/.worktrees/wezdeck/dev-agent',
  probe: '/workspace/.worktrees/wezdeck/task-probe',
  ready: '/workspace/.worktrees/wezdeck/dev-ready',
}

export const STATUS_WORKSTATIONS: WorkstationDirection[] = [
  {
    name: 'agent',
    description: 'Agent 工具与注意力',
    slots: [
      {
        path: STATUS_WORKTREE_PATHS.agent,
        name: 'dev-agent',
        branch: 'dev/agent',
        description: 'Agent 工具与注意力',
        state: 'running',
        sessions: ['demo-agent'],
      },
    ],
  },
  {
    name: 'probe',
    description: '隔离验证',
    slots: [
      {
        path: STATUS_WORKTREE_PATHS.probe,
        name: 'task-probe',
        branch: '',
        description: '隔离验证',
        state: 'detached',
      },
    ],
  },
  {
    name: 'ready',
    description: '已交付的空闲工作树',
    slots: [
      {
        path: STATUS_WORKTREE_PATHS.ready,
        name: 'dev-ready',
        branch: 'dev/ready',
        head: 'a'.repeat(40),
        description: '已交付的空闲工作树',
        state: 'idle',
      },
    ],
  },
]

export const ASK_ONE: Elicitation = {
  questions: [
    {
      header: '数据源',
      question: '周报读哪张表？',
      options: [
        { label: 'dev_report', description: '开发周报明细' },
        { label: 'team_stat', description: '团队统计汇总' },
        { label: '都读', description: '合并两张表' },
      ],
    },
  ],
}
export const ASK_MANY: Elicitation = {
  questions: [
    ...ASK_ONE.questions,
    {
      header: '范围',
      question: '统计哪几周？',
      options: [{ label: '本周' }, { label: '近四周' }],
    },
  ],
}
export const GROK_ASK_MANY: Elicitation = {
  tool_call_id: 'grok-ask-demo',
  questions: [
    {
      question: '周报采用哪种数据源？',
      options: [
        { label: 'dev_report' },
        { label: 'team_stat' },
        { label: 'project_daily' },
        { label: 'commit_log' },
        { label: 'ticket_events' },
        { label: '第六项：合并数据源', description: '验证数字 6 与 Enter' },
      ],
    },
    {
      question: '报告包含哪些部分？',
      multi_select: true,
      options: [
        { label: '本周进展' },
        { label: '风险与阻塞' },
        { label: '下周计划' },
      ],
    },
  ],
}
export const BASH: PendingCall = {
  tool: 'Bash',
  text: 'Bash git push origin master',
  body: 'git push origin master',
}
export const EDIT: PendingCall = {
  tool: 'Edit',
  text: 'Edit /r/web/src/lib/upload.ts',
  file: '/r/web/src/lib/upload.ts',
  body: '@@ -8,3 +8,3 @@\n // a phone screenshot is megabytes of PNG\n-const LONG_EDGE = 1600\n+const LONG_EDGE = 1920\n export async function shrinkImage(file: Blob) {',
}
export const PLAN: PendingCall = {
  tool: 'ExitPlanMode',
  text: 'ExitPlanMode',
  plan: true,
  body: '## 计划\n\n1. relay 下发等待确认的工具调用\n2. 网页渲染确认卡片\n3. 交互调试页加入对照',
}
export const SCREEN =
  ' Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don’t ask again for git push commands\n   3. No, and tell Claude what to do differently (esc)'
export const COMPACT: Array<Message> = [
  { role: 'user', text: '继续上一轮的重构' },
  {
    role: 'system',
    kind: 'compact',
    text: 'auto',
    body: '上下文摘要：已完成 A、B，待做 C。',
    ts: '2026-11-23T10:00:00Z',
  },
  { role: 'assistant', text: '好的，接着做 C。' },
]
export const SLASH: Array<Message> = [
  {
    role: 'system',
    kind: 'slash',
    text: '/model opus',
    body: 'Set model to Opus 5.5',
  },
  {
    role: 'system',
    kind: 'slash',
    text: '/context',
    body: 'Context usage\n  System prompt   3.1k\n  Messages       48.2k\n  Free           120k',
  },
]
/** a running foreground Bash: its row offers 转到后台 (short and long command) */
export const RUNNING = (command: string): Array<Message> => [
  {
    role: 'tool',
    tool: 'Bash',
    kind: 'command',
    text: `Bash ${command}`,
    pending: true,
  },
]
export const RUNNING_SHORT = 'pnpm test'
export const RUNNING_LONG =
  'cd /home/yuns/github/wezterm-config/web && corepack pnpm exec lingui extract >/dev/null 2>&1; cd .. && scripts/dev/check-web.sh 2>&1 | tail -2'
/** background tasks: a described Bash with output, a long Monitor, an id only */
export const BACKGROUND: Array<BgTask> = [
  {
    id: 'b7k2m9',
    type: 'shell',
    summary: 'task:b7k2m9',
    tool: 'Bash',
    label: 'Run the web cdp tests',
    command:
      'scripts/dev/web-affected-tests.sh --run web/tests/chat-stream.cdp.test.ts',
    started: new Date(Date.now() - 95_000).toISOString(),
    at: 3,
    tail: [
      '✓ tests/chat-stream.cdp.test.ts (1 test) 4446ms',
      ' Test Files  1 passed (1)',
    ],
  },
  {
    id: 'mon4x1',
    type: 'monitor',
    summary: 'task:mon4x1',
    tool: 'Monitor',
    label: 'Watch the relay log for git_status rows slower than 300 ms',
    command:
      'tail -F ~/.local/state/wezterm-runtime/logs/relay.log | grep --line-buffered git_status',
    started: new Date(Date.now() - 12 * 60_000).toISOString(),
  },
  { id: 'q93hz0', type: 'shell', summary: 'task:q93hz0' },
]
/** git status of a checkout: staged / modified / untracked, 2 ahead, 1 behind */
export const GIT: GitDetail = {
  status: {
    staged: 1,
    unstaged: 2,
    untracked: 3,
    upstream: true,
    ahead: 2,
    behind: 1,
  },
  branch: 'master',
  upstream: 'origin/master',
  files: [
    { path: 'web/src/features/session-git.tsx', state: 'staged', code: 'A' },
    { path: 'native/wezdeck-wsl/session_git.go', state: 'modified', code: 'M' },
    { path: 'docs/remote-sessions.md', state: 'modified', code: 'M' },
    {
      path: 'web/tests/session-git.cdp.test.ts',
      state: 'untracked',
      code: '?',
    },
    {
      path: 'native/wezdeck-wsl/session_git_test.go',
      state: 'untracked',
      code: '?',
    },
    { path: 'tmp/notes.md', state: 'untracked', code: '?' },
  ],
  ahead: [
    {
      sha: '2f44707',
      subject:
        'fix(web): 运行中插入新工具调用时状态栏不再跳动，整段对话平滑长高',
      body: '- 新的一组工具调用一次性加出整块（逐帧测得状态行先被顶下 128px、每多一行 24px，再滑回）\n- 平滑长高从单条回复提升到整段对话：会话活跃时对话条目外层每帧向真实高度缓动，贴底每帧跟到底，状态行固定',
      author: 'Yuns',
      at: Date.now() - 20 * 60_000,
    },
    {
      sha: '8b26f35',
      subject: 'feat(web): 后台任务显示说明、命令、运行时长与最新输出',
      author: 'Yuns',
      at: Date.now() - 50 * 60_000,
    },
  ],
  behind: [
    {
      sha: '9c1e0aa',
      subject: 'docs: split web-pwa.md by decision domain',
      author: 'Yuns',
      at: Date.now() - 5 * 60_000,
    },
  ],
  recent: [
    {
      sha: '2f44707',
      subject: 'fix(web): 运行中插入新工具调用时状态栏不再跳动',
      author: 'Yuns',
      at: Date.now() - 20 * 60_000,
    },
    {
      sha: '8b26f35',
      subject: 'feat(web): 后台任务显示说明、命令、运行时长与最新输出',
      author: 'Yuns',
      at: Date.now() - 50 * 60_000,
    },
    {
      sha: '3d99814',
      subject: 'fix(web): 长回复流式写出时回复容器平滑长高',
      author: 'Yuns',
      at: Date.now() - 90 * 60_000,
    },
  ],
}
/** task notifications as the thread shows them (kind "task") */
export const TASK_NOTES: Array<Message> = [
  {
    role: 'system',
    kind: 'task',
    text: 'Monitor event: "test 部署 #13241 阶段进度"',
    body: '[cmdb deploy] #13241 [5.9m] ✓ 推送镜像 30s',
  },
  {
    role: 'system',
    kind: 'task',
    text: 'Monitor event: "coco-forge PR #1381 合入与发版进度"',
    body: '⛔ 平台闸门 blocked_on=status_check\n→ 平台这一关没过，不会自动合入\nci: lint ok · unit ok · e2e failed (2)\nretry in 60s\nlast run: https://ci.example/run/4412',
  },
  {
    role: 'system',
    kind: 'task',
    text: 'Monitor "test 部署 #13241 阶段进度" stream ended',
  },
  {
    role: 'system',
    kind: 'task',
    text: 'Background command "推送 test 分支并部署 test" completed (exit code 0)',
  },
]
