import type { CapabilityGroup } from './capabilities'

const c = (name: string, zh: string, en: string) => ({
  name,
  what: { zh, en },
})

export const bridgeCapabilities: CapabilityGroup = {
  id: 'bridge',
  title: {
    zh: 'bridge：Runtime 能问 WSL 的事',
    en: 'bridge: what the Runtime may ask WSL',
  },
  summary: {
    zh: '白名单之外一律拒绝。remote.* 直接复用 relay 的读写函数，所以本机网页端与远程网页端看到的永远一致。',
    en: 'Anything off the list is refused. remote.* reuses the relay’s read and write functions, so the local and remote web console always agree.',
  },
  source: 'native/wezdeck-wsl/serve.go',
  items: [
    c('workspace.catalog', '工作区与仓库目录', 'Workspaces and repositories'),
    c('git.status', '工作树的 git 状态', 'Git status of a worktree'),
    c('status.wakatime', '今日编码时长', 'Today’s coding time'),
    c(
      'collab.*',
      '工单读取：health / list / show / events / run / prompt / transcript / metrics',
      'Ticket reads: health / list / show / events / run / prompt / transcript / metrics',
    ),
    c('remote.<读取>', 'relay 的全部读取', 'Every relay read'),
    c(
      'remote.devices',
      '已登记的设备（待批准 / 已批准，不含公钥）：只给本机浏览器，relay 不提供',
      'Registered devices (pending / approved, no keys): for the host browser only, not over the relay',
    ),
    c(
      'remote.device.approve',
      '批准一台待批准的设备：只给本机浏览器，relay 不提供',
      'Approve a pending device: for the host browser only, not over the relay',
    ),
    c(
      'remote.diag.pending',
      '本机浏览器轮询主机发来的诊断请求（本机模式收不到 relay 推送）：只给本机浏览器',
      'The host browser polling for the host’s diagnostics requests (local mode gets no relay push): host browser only',
    ),
    c(
      'remote.diag.submit',
      '本机浏览器把诊断快照分块交回 relay：只给本机浏览器',
      'The host browser handing its diagnostics snapshot back to the relay, in chunks: host browser only',
    ),
    c(
      'remote.disk.reclaim.status',
      '本机浏览器读取属于自身的磁盘回收进度',
      'Read this browser’s disk reclaim progress from the local Runtime',
    ),
    c(
      'remote.device.revoke',
      '撤销一台已批准的设备，relay 下一次读写即拒绝：只给本机浏览器',
      'Revoke an approved device; the relay refuses its next read or write: for the host browser only',
    ),
    c(
      'remote.<写入>',
      'relay 的全部写入，记为 local',
      'Every relay write, marked local',
    ),
    c('bridge.status', 'bridge 自身状态', 'The bridge’s own status'),
  ],
}
