// Link-quality helpers for the remote link (lib/remote-link.ts): the RTT
// median and which candidate pair carried the DataChannel.
import type { RemotePath } from './remote-link'

export function median(values: Array<number>) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const PRIVATE_ADDRESS =
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd|::1$)/i

/**
 * stats → which candidate pair carried the DataChannel. Chrome hides its own
 * host address behind mDNS, so the host side often sees a peer-reflexive
 * candidate even on one LAN; the remote (host-side) address decides instead.
 */
export async function selectedPath(
  pc: RTCPeerConnection,
): Promise<{ path: RemotePath; detail: string }> {
  const stats = await pc.getStats()
  let pair:
    { localCandidateId?: string; remoteCandidateId?: string } | undefined
  stats.forEach((s: { type: string; nominated?: boolean; state?: string }) => {
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
      pair = s as typeof pair
  })
  const candidate = (id?: string) =>
    id
      ? (stats.get(id) as
          { candidateType?: string; address?: string } | undefined)
      : undefined
  const local = candidate(pair?.localCandidateId)
  const remote = candidate(pair?.remoteCandidateId)
  const detail = `local=${local?.candidateType ?? '?'} remote=${remote?.candidateType ?? '?'} ${remote?.address ?? ''}`
  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay')
    return { path: 'turn', detail }
  return {
    path: PRIVATE_ADDRESS.test(remote?.address ?? '') ? 'lan' : 'internet',
    detail,
  }
}
