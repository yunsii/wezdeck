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
      capabilities: [
        'rime.stats',
        'ime.state',
        'chrome.state',
        'sessions.read',
        'vscode.windows',
        'vscode.focus',
        'vscode.focus_or_open',
        'vscode.close',
        'workspaces.read',
        'diagnostics.logs',
        'events',
      ],
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
  } else if (path === '/api/v1/workspaces') {
    json(res, {
      available: true,
      workspaces: [
        {
          name: 'config',
          items: [
            {
              cwd: '/home/mock/github/example',
              name: 'example',
              worktrees: [
                {
                  path: '/home/mock/github/example',
                  name: 'primary',
                  branch: 'master',
                  kind: 'primary',
                },
              ],
            },
          ],
        },
        { name: 'opensource', items: [] },
        {
          name: 'work',
          items: [
            {
              cwd: '/home/mock/work/example',
              name: 'example',
              worktrees: [
                {
                  path: '/home/mock/work/example',
                  name: 'primary',
                  branch: 'master',
                  kind: 'primary',
                },
              ],
            },
          ],
        },
      ],
      selection: {
        workspace: 'work',
        repo: 'example',
        worktree: '/home/mock/work/example',
      },
    })
  } else if (path === '/api/v1/sessions') {
    json(res, { available: true, entries: {}, recent: [] })
  } else if (path === '/api/v1/vscode') {
    json(res, { available: true, windows: [] })
  } else if (path === '/api/v1/diagnostics') {
    json(res, {
      available: true,
      sources: ['mock:runtime.log'],
      counts: { mock: 1 },
      entries: [
        {
          ts: new Date().toISOString(),
          level: 'info',
          source: 'mock-runtime',
          category: 'mock',
          trace_id: 'mock-trace',
          message: 'mock diagnostics entry',
          stream: 'mock:runtime.log',
          raw: 'mock diagnostics entry',
        },
      ],
    })
  } else if (path.startsWith('/api/v1/actions/')) {
    json(res, {
      ok: true,
      status: 'mocked',
      decision_path: 'mock-runtime',
    })
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
