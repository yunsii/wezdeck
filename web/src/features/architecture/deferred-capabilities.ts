import type { Capability } from './capabilities'

export const deferredWriteCapabilities: Array<Capability> = [
  {
    name: 'deferred.enqueue',
    what: {
      zh: '暂存会话消息，等待本轮结束或人工确认',
      en: 'Hold a session message until the turn ends or you confirm it',
    },
  },
  {
    name: 'deferred.release',
    what: {
      zh: '将一条暂存消息送入会话',
      en: 'Deliver one held message to its session',
    },
  },
  {
    name: 'deferred.cancel',
    what: {
      zh: '移除一条暂存消息',
      en: 'Remove one held message',
    },
  },
]
