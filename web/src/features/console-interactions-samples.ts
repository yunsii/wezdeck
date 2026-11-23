// Sample data for 交互调试 (console-interactions.tsx): one of each special
// interaction the session page renders, fed to the real components.
import type { Message } from './chat-thread'
import type { Elicitation } from './session-elicitation'
import type { PendingCall } from './session-permission'

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
