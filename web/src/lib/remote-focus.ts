// Lightweight foreground visibility & path reporter sent over the relay WS
// so HostRelay DO suppresses duplicate push popups when the user is already
// looking at the same session or ticket on this device.
import { loadDeviceKey } from './device-key'

export function sendFocusFrame(
  ws: WebSocket | undefined,
  pathOverride?: string,
) {
  if (
    typeof window === 'undefined' ||
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return
  }
  const rawPath = pathOverride ?? location.pathname
  const normalized = rawPath.replace(/^\/zh(?=\/|$)/, '') || '/'
  const visible = document.visibilityState === 'visible'
  void loadDeviceKey()
    .then((key) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const deviceId =
        key?.id || localStorage.getItem('wezdeck-push-device-id') || ''
      if (!deviceId) return
      ws.send(
        JSON.stringify({
          t: 'focus',
          device_id: deviceId,
          visible,
          path: normalized,
        }),
      )
    })
    .catch(() => undefined)
}
