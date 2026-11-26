// 交互调试 entries around the conversation: background task notifications,
// the git panel and churn, the status bar, session tags and toasts (split
// from console-interactions-sections.tsx, which keeps the prompts and the
// stream).
import type { Section } from './console-interactions-sections'
import { TaskEventRow } from './chat-command'
import type { Message } from './chat-thread'
import { GitStatusButton } from './session-git'
import { GitStatusTag } from '#/components/deck/session-tags'
import {
  GitChurnDemo,
  StatusBarDemo,
  TagsDemo,
  ToastDemo,
} from './console-interactions-demos'
import { GIT, TASK_NOTES } from './console-interactions-samples'
import { SkillsDemo } from './console-interactions-skills'

/** a clean checkout, no upstream (the synced one adds upstream) */
const CLEAN = {
  staged: 0,
  unstaged: 0,
  untracked: 0,
  upstream: false,
  ahead: 0,
  behind: 0,
}

/** around the conversation: tags, the status bar, git, toasts */
export function chromeSections(): Array<Omit<Section, 'group'>> {
  return [
    {
      id: 'skills',
      tags: ['common'],
      title: { zh: '能力与 / 补全', en: 'Skills and / completion' },
      source: {
        zh: '输入框上方「能力 N」：会话 agent 实际加载的 skill（session.skills：Claude 读转录 skill_listing、Codex 读 rollout、Grok 跑 inspect，session_skills.go），按来源分组、可搜索，点一项放进输入框；输入 / （Codex 为 $）弹出命令与能力补全',
        en: 'the 能力 N chip above the composer: the skills the session agent was actually given (session.skills: Claude transcript skill_listing, Codex rollout, Grok inspect — session_skills.go), grouped by origin and searchable, a tap drafts it; typing / (Codex $) opens command and skill completion',
      },
      keys: {
        zh: '/ 打开补全，↑ ↓ 选择，Tab / Enter 补全，Esc 关闭',
        en: '/ opens completion, ↑ ↓ move, Tab / Enter pick, Esc closes',
      },
      demo: <SkillsDemo />,
    },
    {
      id: 'task-notes',
      tags: ['claude'],
      title: { zh: '后台任务通知', en: 'Background task notifications' },
      source: {
        zh: '转录里的 task-notification（忙时为排队附件，空闲时为一条用户行）：Monitor 事件、Monitor 结束、后台命令结束；像终端一样在到达处显示一行，并挂到发起它的调用上（agent_claude.go taskNotification）',
        en: 'task-notification lines (a queued attachment while busy, a user line when idle): Monitor events, a Monitor ending, a background command ending; a row where it arrived, as the terminal prints it, and onto the call that started it (agent_claude.go taskNotification)',
      },
      keys: { zh: '无（长事件可点开）', en: 'None (a long event opens)' },
      demo: (
        <div className="grid gap-1">
          {TASK_NOTES.map((message: Message) => (
            <TaskEventRow key={message.text} message={message} />
          ))}
        </div>
      ),
    },
    {
      id: 'toasts',
      tags: ['common'],
      title: { zh: '消息提示', en: 'Toasts' },
      source: {
        zh: '复制、发送命令、清空输入、错误、新版本等操作的结果提示（sonner，样式见 deck.css .deck-toast）；会话页里从顶部栏下方弹出，不挡返回按钮',
        en: 'results of copy, commands, clearing, errors, a new version… (sonner, styled by deck.css .deck-toast); on the session page they drop in under the top bar, never over its back button',
      },
      keys: {
        zh: '无（点按钮弹出对应提示）',
        en: 'None (each button shows that toast)',
      },
      demo: <ToastDemo />,
    },
    {
      id: 'status-bar',
      tags: ['common'],
      title: { zh: '底部状态栏', en: 'Status bar' },
      source: {
        zh: '输入框下方一行关键信息：模型、分支、git 改动、linked worktree 数、后台任务（session_env.go / bg_detail.go）；放不下时分支省略、其余收进 +N；linked 与后台任务向上浮出，不推动对话。上下文和额度在空间允许时显示在底栏，折叠的告警在标题栏补充',
        en: 'one line of essentials under the composer: model, branch, git changes, linked worktrees, background tasks (session_env.go / bg_detail.go); the branch truncates, the rest folds behind +N; linked and background tasks open upward without moving the thread. context and account limits use available space in the bottom row, with header alerts for folded metrics',
      },
      keys: { zh: '无（点各项查看）', en: 'None (tap an item)' },
      demo: <StatusBarDemo />,
    },
    {
      id: 'git-churn',
      tags: ['common'],
      title: { zh: 'git 改动频繁变化', en: 'Git counts churning' },
      source: {
        zh: 'agent 改文件时 git 数字每几秒就变：状态栏的 git 标签固定分段（零调暗、每段两位宽），宽度不变，后面的标签不挪动，状态栏始终一行',
        en: 'git counts change every few seconds while the agent edits: a fixed-segment git tag (zeros dimmed, two digits per segment) keeps its width, the tags after it hold still, the bar stays one line',
      },
      keys: { zh: '无', en: 'None' },
      demo: <GitChurnDemo />,
    },
    {
      id: 'session-tags',
      tags: ['common'],
      title: { zh: '会话标签', en: 'Session tags' },
      source: {
        zh: '会话列表的行与详情顶部共用同一个标签行（TagLine）：可换行，单个标签最长占满一整行，再长截断、悬停看全文；中性色标签用半透明底色，在两种底色上看起来一样',
        en: 'the list row and the header share one tag line (TagLine): it wraps, one tag takes at most a whole line (then truncates, full text on hover); neutral tags use a translucent fill that reads the same on both grounds',
      },
      keys: { zh: '无', en: 'None' },
      demo: <TagsDemo />,
    },
    {
      id: 'git-status',
      tags: ['common'],
      title: { zh: 'git 状态面板', en: 'Git status panel' },
      source: {
        zh: '头部分支旁的 +S ~U ?T ↑A ↓B 标签（git_status.go 随轮询）；点开读 session.git：改动文件、未推送 / 未拉取与最近提交（session_git.go）',
        en: 'the +S ~U ?T ↑A ↓B tag beside the branch (git_status.go, on the poll); tapping it reads session.git: changed files, unpushed / unpulled and recent commits (session_git.go)',
      },
      keys: { zh: '无（只读）', en: 'None (read only)' },
      demo: (
        <div className="grid gap-2 text-meta text-brand-label">
          <span className="flex items-center gap-2">
            {/* the header's tag itself: tap it (or Enter / Space) */}
            点标签打开 →
            <GitStatusButton id="sample" git={GIT.status} sample={GIT} />
          </span>
          <span
            data-testid="git-clean-tags"
            className="flex items-center gap-2"
          >
            没有改动时 →
            <GitStatusTag git={{ ...CLEAN, upstream: true }} />
            <GitStatusTag git={CLEAN} />
          </span>
        </div>
      ),
    },
  ]
}
