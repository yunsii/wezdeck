# Development Environment Troubleshooting

Use this doc for development-host failures that cross repository boundaries:
Windows, WSL, DNS, VPN or proxy software, shells, and agent CLIs. For
repository runtime logs and smoke tests, use [`diagnostics.md`](./diagnostics.md)
instead.

## Investigation Model

Do not patch the first application that exposes a host failure. Narrow the
failing layer first:

1. Reproduce the symptom with a bounded timeout.
2. Compare the smallest meaningful variants, such as IPv4 versus IPv6 or UDP
   DNS versus TCP DNS.
3. Repeat the check on both WSL and Windows to locate the ownership boundary.
4. Distinguish installed or running background software from an active data
   path by checking routes, adapters, DNS policy, and connection state.
5. Identify the resolver the failing binary actually uses (glibc vs musl vs a
   user-space resolver). A containment that fixes one binary can be a no-op for
   another that resolves differently — see
   [Why Agent CLIs Stall When Other Tools Do Not](#why-agent-clis-stall-when-other-tools-do-not).
6. Apply a reversible local containment only after the root owner is known.
7. Record the evidence needed by IT or the network owner when the fix is not
   local to the workstation.

Keep credentials out of diagnostics. Generated VPN and proxy configs commonly
contain node passwords or subscription data; inspect only the exact keys needed
for the current hypothesis.

## Agent-CLI Stalls On IPv6 / AAAA DNS

### Symptoms

- A CLI appears frozen while starting a new session or initializing tools.
- A request works with `curl -4` but the default dual-stack request waits for
  several seconds in name resolution.
- Codex `/new` eventually clears the composer and becomes usable without an
  explicit error.
- The delay repeats once per remote MCP authentication or discovery request.

In the investigated incident, the repository's `Ctrl+n` binding was not the
blocking layer. It staged `/new` and Enter with a 100 ms gap, while Codex thread
startup spent about 42 seconds in remote MCP OAuth discovery.

This is intermittent and network-dependent. On a healthy path the default
dual-stack request resolves in a few milliseconds, indistinguishable from
`RES_OPTIONS=no-aaaa`; the stall only appears when the network mishandles AAAA.
Confirm the failure is live before diagnosing (see
[WSL Checks](#wsl-checks)) rather than assuming a past incident is still active.

### This Is Not WSL-Specific

The symptom is caused by an agent CLI's IPv6/AAAA behavior meeting a network
that mishandles AAAA. WSL is a strong amplifier, not the root:

- The same Codex IPv6 stall reproduces on
  [Termux / Android](https://othernotherone.com/posts/codex-cli-termux-fix-ipv6-timeout-issue/),
  where the same command "works instantly in proot Ubuntu on the same device" —
  the variable that changes is the libc, not WSL.
- WSL `mirrored + dnsTunneling` amplifies it because every lookup crosses to the
  Windows DNS client and NODATA AAAA answers are not cached
  ([microsoft/WSL#14568](https://github.com/microsoft/WSL/issues/14568)), so the
  UDP round-trip (and any UDP drop) is paid on every resolution.

See [Why Agent CLIs Stall When Other Tools Do Not](#why-agent-clis-stall-when-other-tools-do-not)
for the resolver mechanism and why colleagues on macOS / native Windows / glibc
Linux often never see it.

### Network Path

```text
WSL process
  -> Linux resolver (glibc getaddrinfo, or a static musl / user-space resolver)
  -> WSL DNS tunneling (10.255.255.254)
  -> Windows DNS client
  -> DHCP-provided DNS / network DNS policy
  -> upstream resolver
```

`10.255.255.254` is the default virtual address used by WSL DNS tunneling; it
is not a public DNS server. Keep `networkingMode=mirrored` and DNS tunneling
enabled unless evidence identifies the tunnel itself as the failure.

Microsoft references:

- [WSL networking and DNS tunneling](https://learn.microsoft.com/windows/wsl/networking#dns-tunneling)
- [Advanced WSL configuration](https://learn.microsoft.com/windows/wsl/wsl-config)
- [Windows DNS over HTTPS](https://learn.microsoft.com/windows-server/networking/dns/doh-client-support)

### WSL Checks

Run the variants separately so one resolver timeout does not hide the others:

```bash
curl -4 --connect-timeout 8 --max-time 12 -o /dev/null -sS \
  -w 'v4 dns=%{time_namelookup} total=%{time_total}\n' \
  https://developers.openai.com/mcp

curl -6 --connect-timeout 8 --max-time 12 -o /dev/null -sS \
  -w 'v6 dns=%{time_namelookup} total=%{time_total}\n' \
  https://developers.openai.com/mcp

curl --connect-timeout 8 --max-time 12 -o /dev/null -sS \
  -w 'auto dns=%{time_namelookup} total=%{time_total}\n' \
  https://developers.openai.com/mcp

RES_OPTIONS=no-aaaa curl --connect-timeout 8 --max-time 12 \
  -o /dev/null -sS \
  -w 'no-aaaa dns=%{time_namelookup} total=%{time_total}\n' \
  https://developers.openai.com/mcp
```

HTTP `405` is an acceptable result for this probe: it proves DNS, TCP, and TLS
completed, while the MCP endpoint rejected the probe's GET method. On a machine
with no global IPv6 address the `-6` probe failing with "Could not resolve host"
is expected, not a new fault — read the `auto` vs `v4` comparison instead.

`curl` links glibc, so it honors `RES_OPTIONS` and reflects the glibc path. It
does **not** reflect what a static-musl agent CLI (Codex) sees; use it to
characterize the network, not to validate a Codex fix.

For a qtype-level answer that is independent of `AI_ADDRCONFIG` and the client
resolver, install `dnsutils` and compare UDP against TCP directly:

```bash
NS=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
dig +time=5 +tries=1      AAAA developers.openai.com @"$NS"   # UDP: stalls when live
dig +tcp +time=5 +tries=1 AAAA developers.openai.com @"$NS"   # TCP: immediate NODATA
dig +time=5 +tries=1      A    developers.openai.com @"$NS"   # control: normal
```

### Windows Checks

Run these from Windows PowerShell. Compare UDP and TCP against both the
DHCP-provided resolver and a public resolver. Find the DHCP resolver with
`Get-DnsClientServerAddress -AddressFamily IPv4`:

```powershell
Resolve-DnsName developers.openai.com -Type AAAA -DnsOnly `
  -Server <dhcp-dns> -QuickTimeout

Resolve-DnsName developers.openai.com -Type AAAA -DnsOnly `
  -Server <dhcp-dns> -TcpOnly -QuickTimeout

Resolve-DnsName developers.openai.com -Type AAAA -DnsOnly `
  -Server 1.1.1.1 -QuickTimeout

Resolve-DnsName developers.openai.com -Type AAAA -DnsOnly `
  -Server 1.1.1.1 -TcpOnly -QuickTimeout
```

Also verify whether proxy products are actually on the data path. A running
service or an Up adapter is not sufficient evidence; check connection state,
default routes, and NRPT policy.

### Confirmed Failure Pattern

The incident matched this matrix:

| Query path | Result |
| --- | --- |
| IPv4 HTTPS | Completed in under one second |
| Default dual-stack HTTPS | Timed out during name resolution |
| AAAA over UDP DNS | Timed out after about seven seconds |
| AAAA over TCP DNS | Returned CNAME plus SOA in under 100 ms |
| AAAA over DoH | Returned the same valid NODATA result immediately |
| `RES_OPTIONS=no-aaaa` | Restored the default request to under one second |

This pattern means that a network device, DNS service, or filtering layer is
dropping a valid UDP DNS response. It is not evidence that the target has a
broken IPv6 server, because the failure occurs before an IPv6 address exists.

In this incident, Cloudflare WARP reported `Disconnected`, and the remaining
Clash Verge adapter had no default route or DNS policy. Their background
services were still running, but neither product owned the active DNS path.

## Why Agent CLIs Stall When Other Tools Do Not

The stall needs a resolver with no graceful IPv6 fallback **and** a network that
mishandles AAAA. Codex supplies the first half; the network supplies the second.

- Codex ships a **statically linked musl** Rust binary
  (`.../codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`, verified
  `static-pie / statically linked`) using `reqwest`, and its binary carries the
  `hickory_resolver` symbol — a pure-Rust user-space resolver.
- musl and `hickory` both read `/etc/resolv.conf` but honor neither the glibc
  `RES_OPTIONS` environment variable nor the `use-vc` / `no-aaaa` resolver
  options, and musl has
  [no `AI_ADDRCONFIG` and no prefer-IPv4](https://wiki.musl-libc.org/functional-differences-from-glibc.html)
  path; `reqwest`/`hyper` also lack full Happy Eyeballs
  ([hyperium/hyper#1316](https://github.com/hyperium/hyper/issues/1316)).
- glibc's `AI_ADDRCONFIG` suppresses AAAA when the host has no global IPv6
  address, which **masks** the same network fault for glibc consumers. That is
  why `curl`, glibc-Linux colleagues, and macOS / native-Windows Codex (a
  different binary using the system resolver) usually never see it.

Practical consequence: **DNS-option-level knobs do not reach Codex.** Codex
exposes no DNS / IPv4 / IPv6 setting of its own; the only external lever it
honors is `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY` (standard `reqwest`
behavior).

## Temporary Containment

Scope the containment to the resolver the failing binary uses. A glibc-only knob
will read as "fixed" in `curl` while Codex still stalls.

### glibc consumers (curl, some `node` `dns.lookup`)

`RES_OPTIONS=no-aaaa` requires **glibc ≥ 2.36** (check with
`getconf GNU_LIBC_VERSION`; on older distros the option is silently ignored). It
does not affect static-musl binaries. Use the repository's standard user-level
environment directory so new shells and every managed agent launcher inherit it,
and keep the file shell-clean (`KEY=VALUE`, no `export`, so
`runtime-env-lib.sh`'s `read_key` parser also matches it):

```bash
mkdir -p ~/.config/shell-env.d
printf '%s\n' 'RES_OPTIONS=no-aaaa' \
  > ~/.config/shell-env.d/wsl-dns-ipv4.env
```

Restart the affected CLI process; an already-running process cannot inherit a
new parent environment value. A full `wsl --shutdown` is not required.

Remove the containment after the network fix:

```bash
rm ~/.config/shell-env.d/wsl-dns-ipv4.env
```

### Static-musl agent CLIs (Codex)

`RES_OPTIONS` and `NODE_OPTIONS=--dns-result-order=ipv4first` do **not** reach
the Codex Rust engine (`NODE_OPTIONS` only affects the Node launcher, not the
musl binary that makes the requests). Two levers do reach it:

- **Route Codex through an IPv4-capable proxy.** Codex honors the proxy
  variables, so DNS is resolved by the proxy end and the local AAAA path is
  bypassed. Keep `NO_PROXY` covering internal ranges. This adds a proxy to the
  data path, so treat it as temporary:

  ```bash
  printf '%s\n' \
    'HTTPS_PROXY=http://127.0.0.1:7890' \
    'ALL_PROXY=http://127.0.0.1:7890' \
    'NO_PROXY=localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.internal' \
    > ~/.config/shell-env.d/codex-proxy.env
  ```

- **Disable kernel IPv6** so no resolver attempts AAAA. This cuts the shared
  IPv6 capability layer, so it is effective but global:

  ```bash
  sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1
  # persist under /etc/sysctl.d/ only if you accept host-wide IPv6 loss
  ```

Do not try to fix Codex by editing `/etc/resolv.conf`: `hickory` ignores
`use-vc` / `no-aaaa`, and on WSL the file is a symlink to `/mnt/wsl/resolv.conf`
that WSL regenerates. Do not disable `dnsTunneling` to self-manage `resolv.conf`
either — it diverges from the repository's `mirrored + dnsTunneling` model and
still cannot force `hickory` onto TCP.

This containment is intentionally local. It preserves DHCP, Windows DNS,
internal domains, mirrored networking, and DNS tunneling. It must not be treated
as a substitute for repairing a network that is expected to provide IPv6.

## Root Fix And Ownership

The only clean fix that covers every consumer — glibc, musl, and `hickory`
alike — is at the shared DNS boundary, not per-CLI. Keep Windows DNS set to
automatic when DHCP and internal name resolution are managed by the network. The
network owner should fix the DHCP-provided DNS, gateway, firewall, or
transparent DNS interception so valid AAAA NODATA responses are returned over
UDP. Moving the managed DNS boundary to TCP or DoH is also valid — because Codex
resolves through the WSL tunnel to the Windows DNS client, encrypting or
forcing TCP there benefits every WSL resolver at once, without per-app knobs and
without losing IPv6 — but it belongs at that boundary rather than in each WSL
distro.

Provide IT with this evidence:

```text
AAAA over UDP DNS times out against both the DHCP resolver and an explicit
public resolver. The same query succeeds immediately over TCP DNS and DoH.
The affected hostname has a valid CNAME plus SOA NODATA response. WARP is
disconnected, and the inactive Clash TUN owns no default route or NRPT rule.
Please check UDP/53 interception, DNS ALG/filtering, and where the response is
lost by capturing at the client and DNS egress boundaries.
```

Do not work around a managed DNS failure by permanently replacing an
automatically assigned Windows DNS server with a public resolver; that can
silently break internal and split-horizon domains.

## Validation

Validate against the binary that actually failed, not a glibc stand-in. The
presence of `RES_OPTIONS=no-aaaa` in an environment proves injection, not
effect, and is meaningless for the static-musl Codex engine.

The issue is contained when all of the following hold:

- A newly launched Codex process no longer waits on repeated MCP OAuth discovery
  DNS failures during `/new` (the required, binary-specific criterion).
- Five consecutive default HTTPS probes complete name resolution in under one
  second.
- Windows DHCP DNS and WSL `mirrored + dnsTunneling` remain unchanged.

The issue is root-fixed only after the same UDP AAAA query returns a valid
NODATA response without any containment; remove the containment and repeat the
validation at that point.
