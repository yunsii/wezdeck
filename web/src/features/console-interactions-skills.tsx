// 交互调试 › 能力与 / 补全: the composer's 能力 chip and sheet and the `/`
// completion on sample data (no host read), so agents verify them headless
// (tests/session-skills.cdp.test.ts).
import { useState } from 'react'

import { Textarea } from '#/components/ui/textarea'
import { useSkillCompletion } from './composer-complete'
import type { SkillsReply } from './skill-complete'

export const SAMPLE_SKILLS: SkillsReply = {
  agent: 'claude',
  trigger: '/',
  rev: '6-sample',
  skills: [
    {
      name: 'adversarial-review',
      origin: 'wezdeck',
      description:
        'Multi-role adversarial code review (find → refute → repro).',
    },
    {
      name: 'brainstorm',
      origin: 'wezdeck',
      description: 'Multi-persona divergent → convergent brainstorm.',
    },
    {
      name: 'frontend-design',
      origin: 'project',
      description: 'Visual direction for web pages.',
    },
    {
      name: 'coco-logs',
      origin: 'user',
      description: '内部服务日志查询。',
    },
    { name: 'anthropic-skills:pdf', origin: 'plugin' },
    {
      name: 'code-review',
      origin: 'builtin',
      description: 'Review the current diff for correctness bugs.',
    },
  ],
}

export function SkillsDemo() {
  const [text, setText] = useState('')
  const complete = useSkillCompletion(
    { id: 'sample', text, setText },
    { agent: 'claude', skills_rev: SAMPLE_SKILLS.rev },
    SAMPLE_SKILLS,
  )
  return (
    <div data-testid="skills-demo" className="grid gap-1.5">
      {complete.list}
      <div className="flex">{complete.chip}</div>
      {complete.sheet}
      <Textarea
        data-testid="skills-demo-input"
        {...complete.inputProps}
        value={text}
        rows={1}
        placeholder="输入 / 试试"
        onChange={(event) => {
          setText(event.target.value)
          complete.track(event.target.selectionStart)
        }}
        onKeyDown={(event) => {
          complete.key(event)
        }}
      />
    </div>
  )
}
