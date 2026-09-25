import http from 'node:http'

const port = Number(process.env.WEZDECK_RUNTIME_PORT || 35791)
const startedAt = Date.now()

function json(res, body, status = 200) {
  res.writeHead(status, {
    'access-control-allow-origin': process.env.WEZDECK_WEB_ORIGIN || '*',
    'access-control-allow-headers': 'content-type, authorization',
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': process.env.WEZDECK_WEB_ORIGIN || '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    })
    res.end()
    return
  }
  const path = new URL(req.url || '/', `http://${req.headers.host}`).pathname
  if (path === '/api/v1/health') {
    json(res, {
      api_version: 'v1',
      instance_id: 'mock-runtime',
      ready: true,
      uptime_ms: Date.now() - startedAt,
      capabilities: ['rime.stats', 'ime.state', 'chrome.state', 'events'],
      observed_at: new Date().toISOString(),
    })
  } else if (path === '/api/v1/rime/stats') {
    json(res, {
      events: 13,
      chars: 26,
      today_events: 13,
      today_chars: 26,
      first_ts: new Date(Date.now() - 12_000).toISOString(),
      last_ts: new Date().toISOString(),
    })
  } else if (path === '/api/v1/ime') {
    json(res, { mode: 'rime', lang: 'zh-CN', reason: 'mock sample' })
  } else if (path === '/api/v1/chrome') {
    json(res, { mode: 'headless', alive: true, port: 9222, pid: null })
  } else if (path === '/events') {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(
      'mock runtime exposes REST only; use a real Runtime for WebSocket events',
    )
  } else {
    json(res, { error: 'not_found' }, 404)
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock WezDeck Runtime listening on http://127.0.0.1:${port}`)
})
