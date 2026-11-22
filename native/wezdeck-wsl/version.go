package main

// buildVersion: the source fingerprint of native/wezdeck-wsl
// (scripts/dev/source-fingerprint.sh), stamped by build.sh via -ldflags. The
// relay logs it on every connect: the cdp tests refuse to run against a
// stale test relay, and wezdeck-release.sh skips a restart when it matches.
var buildVersion = "dev"
