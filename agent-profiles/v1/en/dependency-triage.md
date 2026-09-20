---
name: dependency-triage
scope: user
triggers:
  - external dependency failure
  - third-party library or package bug
  - upstream regression or version conflict
  - open-source issues discussions search
  - internal service or private package triage
  - dependency-related fault investigation
tags: [troubleshooting, dependencies, upstream, evidence, triage]
---

# Dependency Triage

## When To Read

When the failure, regression, build break, runtime error, or unclear
behavior likely involves a **dependency** — a third-party library,
package registry artifact, open-source upstream, vendor SaaS / SDK,
or an **internal** service / private package / org platform — rather
than only first-party application logic you own in the current repo.

## When Not To Read

When the task is pure first-party design, a local typo / logic bug
already explained by local evidence, or mechanical edits with no
dependency symptom. Prefer [implementation.md](./implementation.md)
for design prior art and [tool-use.md](./tool-use.md) for generic
evidence-tool choice; this file is the **fault-triage** playbook.

## Why This Exists

Dependency faults are a vertical SRE-style case: the owning system is
often **outside** the current checkout. Local reading alone invents
patches for problems the upstream tracker, changelog, or discussions
already named. Community practice converges on: classify the
dependency, search upstream communication surfaces early, stay
systematic (symptom → hypothesis → test), and prefer reproduce /
version-narrowing over guess-and-retry. This topic makes that default
mandatory for agents across repositories.

Related posture (do not duplicate full text):

- Design prior art → [implementation-45]–[implementation-49]
- Evidence depth → [implementation-50]–[implementation-57]
- Generic evidence tools → [tool-use-38]–[tool-use-43]
- Reproduce / root cause → [validation-33]–[validation-36]
- Closed-loop reporting → [reporting-33]–[reporting-35]

## Classify First

Before deep diving, name the dependency and its class:

- [dependency-triage-01] Capture the **narrow symptom card** first:
  failing command or stack slice, package / service name, pinned or
  resolved version (lockfile / SBOM / image tag when present), and
  whether the break started after a bump, sync, or deploy.
- [dependency-triage-02] Classify as one of:

  - **Public external** — OSS library, public registry package,
    public upstream repo, public docs / CDN.
  - **Vendor / SaaS** — commercial SDK, hosted API, closed docs with
    status pages or support forums.
  - **Internal** — private package, org service, intranet API, or
    host-only platform tooling with no useful public tracker.

- [dependency-triage-03] If class is unclear, spend one short pass to
  resolve ownership (manifest, import path, deploy config, CODEOWNERS)
  before choosing the evidence lane. Do not default to "rewrite local
  code" while ownership is unknown.

## Evidence Lanes (Hard Defaults)

### Public external (including open source)

- [dependency-triage-10] **Prioritize current web and upstream
  history research** before inventing a local workaround or deep
  first-party rewrite. Parallelize with local repro narrowing; do not
  serialize "finish reading the whole local tree" ahead of a
  five-minute upstream search when the error string or version bump
  already points outside.
- [dependency-triage-11] For open-source upstreams, search **Issues,
  Discussions, Pull Requests, release notes / changelogs, and
  security advisories** for the same error signature, version range,
  and platform. Prefer matches that name the version you run.
- [dependency-triage-12] Use **source-indexed upstream repository
  analysis** when you need how the dependency actually works (API
  shape, control flow, known footguns) — not only blog summaries.
  Keep this profile capability-based; map to the concrete host skill
  or MCP in host / skill docs (commonly a DeepWiki-class tool).
- [dependency-triage-13] Use a **live browser** capability when the
  decisive evidence is on a rendered page the fetch/search slice
  misses: GitHub issue threads with truncated replies, docs that
  require navigation, status pages, interactive API explorers, or
  console / network reproduction in a real page. Map to the host
  browser skill or MCP; do not claim you "checked the page" from
  memory.
- [dependency-triage-14] Prefer **official docs + changelog + tracker**
  over secondary Q&A when they conflict. Cite what you adopted,
  adapted, or rejected (same spirit as [implementation-47]).

### Vendor / SaaS

- [dependency-triage-20] Search vendor status, changelog, known-issue
  lists, and support docs with the same priority as OSS trackers.
- [dependency-triage-21] Do not treat internal speculation as a
  substitute for vendor-documented behavior when a public contract
  exists.

### Internal dependencies

- [dependency-triage-30] Prefer **org-local investigation tools**
  available in the current host skill set — service inventory /
  deploy state, request logs and traces, product analytics / event
  streams, internal docs / CMDB / ownership maps — over generic public
  web search.
- [dependency-triage-31] Public web search for internal-only names is
  a last resort (leaks risk + low hit rate). If you must search the
  public web, scrub identifiers and treat hits as untrusted.
- [dependency-triage-32] When internal and public layers mix (e.g.
  internal wrapper around an OSS client), triage **both** lanes: wrap
  ownership locally / internally, upstream behavior via the public
  external lane.

## Systematic Loop

- [dependency-triage-40] Stay systematic: symptom card → classify →
  evidence lane → hypothesis → smallest test → update the card.
  Skipping the hypothesis step and patching from vibes is a failure
  mode ([validation-36]).
- [dependency-triage-41] Reproduce or version-narrow when practical
  (minimal failing case, pin / bisect / last-known-good). A flaky or
  unreproduced dependency blame is not yet a root cause
  ([validation-33], [validation-34]).
- [dependency-triage-42] Time-box upstream search to decision value
  ([implementation-48]). Inconclusive search is a finding: say what
  you queried and that no matching upstream signal appeared, then
  continue with local evidence — do not loop endlessly.
- [dependency-triage-43] If upstream already has a fix, workaround, or
  "won't fix", prefer adopting that path (upgrade, pin, documented
  workaround, or explicit local adaptation) over a silent divergent
  fork — unless project policy forbids it; state the choice.
- [dependency-triage-44] Batch independent evidence calls in one turn
  ([tool-use-08]): e.g. web search + issue search + local lockfile
  read together when they do not depend on each other.

## Capability Map (Examples, Not Hard-Coded Tools)

Durable rules name **capabilities**. Concrete CLIs / MCPs change by
host; resolve them via available skills.

| Need | Capability | Typical host mapping (examples) |
| --- | --- | --- |
| Ecosystem / regression / advisory | Current web + issue-history research | Web search, `gh`, tracker search |
| How upstream code works | Source-indexed upstream analysis | DeepWiki-class MCP / skill |
| Rendered docs, threads, live page behavior | Live browser inspect / navigate | Chrome DevTools-class MCP / skill |
| Supported public contract | Official docs / changelog / release notes | Docs fetch, Context7-class lib docs |
| Internal service health / deploy | Org service & deploy inventory | Internal service / CMDB skills |
| Internal request path | Logs / traces by request id | Internal log skills |
| Internal user-visible path | Product event / analytics query | Internal events skills |

- [dependency-triage-50] Do not hard-code product names into new
  profile rules; extend this table in host or skill docs when the
  mapping changes.
- [dependency-triage-51] If a required capability is missing on the
  host, say so explicitly and fall back to the next best evidence —
  do not invent upstream conclusions ([reporting-28]).

## Reporting

- [dependency-triage-60] In the investigation or fix report, name the
  dependency class, evidence lane used, and the concrete upstream or
  internal sources checked (issue / discussion / changelog / log
  query). Align with [reporting-26].
- [dependency-triage-61] Distinguish: upstream confirmed bug, local
  misuse of a public contract, internal outage / misconfig, and
  still-unknown. Do not blur them.

## Anti-Patterns

- [dependency-triage-70] Rewriting first-party code to paper over an
  undiagnosed upstream regression without searching the tracker.
- [dependency-triage-71] Deep public-web rabbit holes for internal-only
  services while skipping org log / deploy tools.
- [dependency-triage-72] Claiming "no one else hit this" without
  searching Issues / Discussions / advisories for the version you run.
- [dependency-triage-73] Treating a single blog post or unverified
  forum reply as stronger than changelog + tracker + current source.
- [dependency-triage-74] Opening a new upstream issue before searching
  existing threads (duplicate noise).

## Prior Art (Adopted / Adapted)

Adopted and adapted for agent defaults:

- Systematic debugging: collect data → hypothesize → test; reproduce
  outside prod when possible (Google *Building Secure & Reliable
  Systems*, debugging chapter; SRE debugging practice).
- Dependency failure as a first-class underlying-cause class in
  production triage (Google Queue research on distributed debugging).
- Check the package issue tracker / communication surfaces early when
  consuming OSS (*Surviving Software Dependencies*, CACM; *Managing
  the Open Source Dependency*).
- Version-narrow / bisect when a bump correlates with the break
  (community regression tools such as dependency bisect utilities).
- Events / recent-change first before deep config archaeology (common
  SRE playbook pattern).

Rejected as the primary frame: org-wide dependency-*governance*
programs (central artifact policy, training curricula) — useful for
platforms, too heavy for per-incident agent triage. This topic stays
on **fault investigation**, not inventory policy.
