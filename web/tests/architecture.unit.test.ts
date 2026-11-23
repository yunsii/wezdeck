import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { capabilityGroups } from '#/features/architecture/capabilities'
import { flows } from '#/features/architecture/flows'
import { overview } from '#/features/architecture/overview'
import { securityDiagram } from '#/features/architecture/security'
import { layout, problems } from '#/features/architecture/layout'

// The architecture page (features/architecture) lists every entry point of
// the local services. These read the lists out of the source and compare, so
// a new endpoint, action or RPC fails here until the page describes it.
const repo = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

const RUNTIME = 'native/wezdeck-runtime/windows/src/Runtime'
const WSL = 'native/wezdeck-wsl'

const names = (id: string) =>
  new Set(
    capabilityGroups
      .find((group) => group.id === id)
      ?.items.map((item) => item.name),
  )

/** the quoted strings in `case "a", "b":` lines inside one Go function */
function goCases(source: string, func: RegExp) {
  const start = source.search(func)
  expect(start, `function ${func} not found`).toBeGreaterThanOrEqual(0)
  const body = source.slice(start, source.indexOf('\n}\n', start))
  const out = new Set<string>()
  for (const line of body.matchAll(/^\s*case\s+("[^:]+):/gm))
    for (const quoted of line[1].matchAll(/"([^"]+)"/g)) out.add(quoted[1])
  return out
}

const sorted = (set: Set<string>) => [...set].sort()

describe('architecture page: diagrams', () => {
  it.each([overview, ...flows, securityDiagram].map((d) => [d.id, d]))(
    '%s is well formed',
    (_, diagram) => {
      expect(problems(diagram)).toEqual([])
      // two cards never share a lane cell
      const cells = layout(diagram).placed.map((p) => `${p.x}:${p.y}`)
      expect(new Set(cells).size).toBe(cells.length)
    },
  )
})

describe('architecture page: capabilities match the source', () => {
  it('Runtime GET endpoints', () => {
    const source = repo(`${RUNTIME}/RuntimeWebServer.cs`)
    const routes = new Set(
      [...source.matchAll(/^\s*"(\/api\/v1\/[a-z/]+)" =>/gm)].map((m) => m[1]),
    )
    routes.add('/events') // the WebSocket, matched before the switch
    const page = names('runtime-http')
    // prefixes are separate handlers (collab / remote), listed with a placeholder
    const listed = new Set([...page].filter((name) => !name.includes('<')))
    expect(sorted(listed)).toEqual(sorted(routes))
    expect([...page].some((name) => name.startsWith('/api/v1/collab/'))).toBe(
      true,
    )
    expect([...page].some((name) => name.startsWith('/api/v1/remote/'))).toBe(
      true,
    )
  })

  it('Runtime capability list is covered by the endpoints described', () => {
    const source = repo(`${RUNTIME}/RuntimeWebServer.cs`)
    const block = source.slice(
      source.indexOf('["capabilities"]'),
      source.indexOf('},', source.indexOf('["capabilities"]')),
    )
    const caps = [...block.matchAll(/"([a-z_.]+)"/g)]
      .map((m) => m[1])
      .filter((c) => c !== 'capabilities')
    expect(caps.length).toBeGreaterThan(10)
    // each capability's domain shows up somewhere on the page
    const text = JSON.stringify(capabilityGroups).toLowerCase()
    for (const cap of caps) {
      const domain = cap.split('.')[0] ?? ''
      const alias: Record<string, string> = {
        workspaces: 'workspace',
        diagnostics: 'diagnostics',
        wsl: 'wsl',
        events: '/events',
        rime: 'rime',
      }
      expect(text, cap).toContain(alias[domain] ?? domain)
    }
  })

  it('Runtime host actions', () => {
    const source = repo(`${RUNTIME}/RequestRouter.cs`)
    const actions = new Set(
      [...source.matchAll(/\("([a-z_]+)", "([a-z_]+)"\) =>/g)].map(
        (m) => `${m[1]}/${m[2]}`,
      ),
    )
    expect(sorted(names('runtime-actions'))).toEqual(sorted(actions))
  })

  it('Runtime collab and remote allowlists', () => {
    const collab = repo(`${RUNTIME}/RuntimeWebServer.Collab.cs`)
    const keys = collab.slice(
      collab.indexOf('CollabQueryKeys'),
      collab.indexOf('};', collab.indexOf('CollabQueryKeys')),
    )
    const commands = [...keys.matchAll(/\["([a-z]+)"\] = /g)].map((m) => m[1])
    expect(commands.length).toBeGreaterThan(5)
    const described = capabilityGroups
      .find((g) => g.id === 'runtime-http')
      ?.items.find((i) => i.name.startsWith('/api/v1/collab/'))
    for (const command of commands)
      expect(described?.what.en, command).toContain(command)

    const remote = repo(`${RUNTIME}/RuntimeWebServer.Remote.cs`)
    const set = (name: string) => {
      const start = remote.indexOf(name)
      const block = remote.slice(
        remote.indexOf('{', start),
        remote.indexOf('};', start),
      )
      return new Set([...block.matchAll(/"([a-z.]+)"/g)].map((m) => m[1]))
    }
    expect(sorted(set('RemoteReadActions'))).toEqual(
      sorted(names('relay-reads')),
    )
    expect(sorted(set('RemoteWriteActions'))).toEqual(
      sorted(names('relay-writes')),
    )
  })

  it('relay reads, writes and the rest', () => {
    const relay = repo(`${WSL}/relay.go`)
    expect(sorted(goCases(relay, /^func readRPC\(/m))).toEqual(
      sorted(names('relay-reads')),
    )
    const dispatch = goCases(relay, /^func dispatchRPC\(/m)
    const writes = names('relay-writes')
    expect(
      sorted(new Set([...dispatch].filter((a) => !writes.has(a)))),
    ).toEqual(sorted(names('relay-other')))
    expect(sorted(new Set([...dispatch].filter((a) => writes.has(a))))).toEqual(
      sorted(writes),
    )
    // runWrite's default branch is reply
    const run = goCases(repo(`${WSL}/remote_write.go`), /^func runWrite\(/m)
    run.add('reply')
    expect(sorted(run)).toEqual(sorted(writes))
  })

  it('bridge allowlist', () => {
    const serve = goCases(
      repo(`${WSL}/serve.go`),
      /^func dispatch\(req request\)/m,
    )
    const page = names('bridge')
    const reads = names('relay-reads')
    const writes = names('relay-writes')
    for (const action of serve) {
      if (action.startsWith('collab.'))
        expect(page.has('collab.*'), action).toBe(true)
      else if (action.startsWith('remote.')) {
        const rest = action.slice('remote.'.length)
        expect(reads.has(rest) || writes.has(rest), action).toBe(true)
      } else expect(page.has(action), action).toBe(true)
    }
  })
})
