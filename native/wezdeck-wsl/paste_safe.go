package main

// pasteSafe keeps a phone message plain text before it goes into a pane as
// a bracketed paste. ESC and the other control characters would end the
// paste early ("ESC[201~") and the bytes after it would reach the agent TUI
// as keys — Shift+Tab ("ESC[Z") switches Claude Code's permission mode —
// bypassing the `key` allowlist. Kept: newline and tab. CR LF / CR become
// newlines; C0, DEL and the C1 range (U+0080–U+009F, 8-bit CSI among them)
// are dropped.

import "strings"

func pasteSafe(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\t':
			return r
		case r < 0x20, r == 0x7f, r >= 0x80 && r <= 0x9f:
			return -1
		}
		return r
	}, text)
}
