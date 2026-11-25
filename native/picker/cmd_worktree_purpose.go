package main

// Ctrl+E in the Alt+g picker: edit the focused workstation's one-line
// purpose (its git branch description) in place. Saving runs the same
// `worktree-task describe --set / --clear` as the CLI, so the purpose has one
// writer path. Only workstations have one: the primary checkout and the
// ticket-* / claw-* worktrees of agent-collab / OpenClaw are refused with a
// flash.

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// purposeMax mirrors wt_workstation_clean_description (120 characters).
const purposeMax = 120

// purposeEditor is the open Ctrl+E overlay: text being typed plus the
// bytes of a rune split across two reads (readKey reads at most 16 bytes,
// so an IME committing six or more Chinese characters arrives in pieces).
type purposeEditor struct {
	row     int
	text    []rune
	pending []byte
}

// beginPurposeEdit opens the editor on the focused row, prefilled with its
// current purpose; refuses rows that are not workstations.
func (ui *worktreeUI) beginPurposeEdit() {
	if ui.selected < 0 || ui.selected >= len(ui.rows) {
		return
	}
	r := ui.rows[ui.selected]
	base := filepath.Base(r.path)
	switch {
	case r.label == "primary":
		ui.flash = "the primary checkout has no purpose; workstations do"
		return
	case strings.HasPrefix(base, "ticket-"), strings.HasPrefix(base, "claw-"):
		ui.flash = base + " belongs to agent-collab / OpenClaw, not a workstation"
		return
	case r.branch == "":
		ui.flash = "detached HEAD: no branch to describe"
		return
	}
	ui.editing = &purposeEditor{row: ui.selected, text: []rune(r.description)}
}

// purposeKey feeds one read into the editor. Returns done=true when the
// overlay closes (saved or cancelled).
func (ui *worktreeUI) purposeKey(key string) (done bool) {
	ed := ui.editing
	switch key {
	case "\r", "\n":
		ui.savePurpose()
		ui.editing = nil
		return true
	case "\x1b", "\x03":
		ui.editing = nil
		ui.flash = "purpose unchanged"
		return true
	case "\x7f", "\x08":
		ed.pending = nil
		if len(ed.text) > 0 {
			ed.text = ed.text[:len(ed.text)-1]
		}
		return false
	case "\x15": // Ctrl+U
		ed.pending = nil
		ed.text = nil
		return false
	}
	if strings.HasPrefix(key, "\x1b") { // arrows and other sequences: ignore
		return false
	}
	ed.appendBytes([]byte(key))
	return false
}

// appendBytes adds whole printable runes; an incomplete trailing rune
// waits in pending for the next read. Control characters (tabs, newlines
// from a paste) become spaces: the purpose is one line.
func (ed *purposeEditor) appendBytes(b []byte) {
	buf := append(ed.pending, b...)
	ed.pending = nil
	for len(buf) > 0 {
		r, size := utf8.DecodeRune(buf)
		if r == utf8.RuneError && size <= 1 {
			if !utf8.FullRune(buf) {
				ed.pending = append([]byte(nil), buf...)
				return
			}
			buf = buf[1:] // invalid byte: drop it
			continue
		}
		buf = buf[size:]
		if r < 0x20 || r == 0x7f {
			r = ' '
		}
		if len(ed.text) < purposeMax {
			ed.text = append(ed.text, r)
		}
	}
}

// savePurpose writes through worktree-task describe and updates the row.
func (ui *worktreeUI) savePurpose() {
	ed := ui.editing
	if ed == nil || ed.row < 0 || ed.row >= len(ui.rows) {
		return
	}
	text := strings.TrimSpace(string(ed.text))
	r := &ui.rows[ed.row]
	if text == strings.TrimSpace(r.description) {
		ui.flash = "purpose unchanged"
		return
	}
	if err := runWorktreeDescribe(ui.openScript, r.path, text); err != nil {
		ui.flash = "saving the purpose failed: " + err.Error()
		return
	}
	r.description = text
	if text == "" {
		ui.flash = "purpose cleared"
	} else {
		ui.flash = "purpose saved"
	}
}

// runWorktreeDescribe runs scripts/runtime/worktree/worktree-task describe
// next to openScript (scripts/runtime/tmux-worktree-open.sh). Tests swap it.
var runWorktreeDescribe = func(openScript, worktreePath, text string) error {
	if openScript == "" {
		return fmt.Errorf("open script path empty")
	}
	cli := filepath.Join(filepath.Dir(openScript), "worktree", "worktree-task")
	args := []string{"describe", "--cwd", worktreePath}
	if text == "" {
		args = append(args, "--clear")
	} else {
		args = append(args, "--set", text)
	}
	cmd := exec.Command(cli, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("%s", msg)
		}
		return err
	}
	return nil
}

func (ui *worktreeUI) renderPurposeEdit() {
	const reset = "\x1b[0m"
	const clearEOL = "\x1b[K"
	ed := ui.editing
	name := ""
	if ed.row >= 0 && ed.row < len(ui.rows) {
		name = displayWorktreeLabel(ui.rows[ed.row].label)
	}
	var b strings.Builder
	b.WriteString("\x1b[H\x1b[2J")
	b.WriteString("\x1b[1;1H\x1b[1mPurpose of " + name + reset + clearEOL)
	b.WriteString("\x1b[3;1H> " + string(ed.text) + "\x1b[7m \x1b[27m" + clearEOL)
	fmt.Fprintf(&b, "\x1b[5;1H\x1b[2mEnter save · Esc cancel · Ctrl+U clear · empty = remove · %d/%d%s%s",
		len(ed.text), purposeMax, reset, clearEOL)
	_, _ = os.Stdout.WriteString(b.String())
}
