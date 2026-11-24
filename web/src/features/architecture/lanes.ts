// Lanes shared by the diagrams: where something runs.
import type { Lane } from './model'

export const DEVICE: Lane = {
  key: 'device',
  label: { zh: '网页端', en: 'Web console' },
}
export const CLOUD: Lane = {
  key: 'cloud',
  label: { zh: 'Cloudflare', en: 'Cloudflare' },
}
export const WINDOWS: Lane = {
  key: 'windows',
  label: { zh: 'Windows 主机', en: 'Windows host' },
}
export const WSL: Lane = { key: 'wsl', label: { zh: 'WSL', en: 'WSL' } }

export const YOU: Lane = { key: 'you', label: { zh: '你', en: 'You' } }
export const INITIATOR: Lane = {
  key: 'initiator',
  label: { zh: '发起仓库', en: 'Initiating repo' },
}
export const STORE: Lane = {
  key: 'store',
  label: { zh: '工单库', en: 'Ticket store' },
}
export const RUNNER: Lane = {
  key: 'runner',
  label: { zh: '后台 Agent', en: 'Headless agent' },
}
export const AGENT: Lane = { key: 'agent', label: { zh: 'Agent', en: 'Agent' } }
