// Which tab the git sheet opens on (session-git.tsx): the changes when there
// are any, else the commits — whichever explains the header's tag.
import type { GitDetail } from './session-git'

export type GitTab = 'changes' | 'commits'

export const defaultGitTab = (detail: GitDetail): GitTab =>
  detail.files.length ? 'changes' : 'commits'
