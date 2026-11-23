package main

// Edit / Write diffs as real hunks. Claude records the applied patch with
// the tool result (toolUseResult.structuredPatch: line numbers, context,
// -/+ lines); the call's input only has old / new strings, which toolBody
// turned into "everything old red, everything new green". Once the result
// is in, the body becomes unified hunks:
//   @@ -12,4 +12,5 @@
//    context
//   -removed
//   +added
// The phone numbers the lines from the headers (chat-tools.tsx).

import (
	"fmt"
	"strings"
)

type patchHunk struct {
	OldStart int      `json:"oldStart"`
	OldLines int      `json:"oldLines"`
	NewStart int      `json:"newStart"`
	NewLines int      `json:"newLines"`
	Lines    []string `json:"lines"`
}

const patchMaxLines = 160

func patchBody(hunks []patchHunk) string {
	var b strings.Builder
	n := 0
	for _, h := range hunks {
		if n >= patchMaxLines {
			break
		}
		fmt.Fprintf(&b, "@@ -%d,%d +%d,%d @@\n", h.OldStart, h.OldLines, h.NewStart, h.NewLines)
		for i, l := range h.Lines {
			if n >= patchMaxLines {
				fmt.Fprintf(&b, "… (+%d lines)\n", len(h.Lines)-i)
				break
			}
			if l == "" || !strings.ContainsRune("+- \\", rune(l[0])) {
				l = " " + l
			}
			// not clip(): it trims, and the leading space marks context
			if r := []rune(l); len(r) > 400 {
				l = string(r[:400]) + "…"
			}
			b.WriteString(l + "\n")
			n++
		}
	}
	return strings.TrimRight(b.String(), "\n")
}
