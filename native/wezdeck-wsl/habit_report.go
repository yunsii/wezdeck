package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type habitWindow struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type habitDay struct {
	Day        string `json:"day"`
	Commits    int    `json:"commits"`
	WebRelated int    `json:"web_related"`
}

type habitFocus struct {
	OK         bool           `json:"ok"`
	Commits    int            `json:"commits"`
	WebRelated int            `json:"web_related"`
	Areas      map[string]int `json:"areas"`
	Daily      []habitDay     `json:"daily"`
}

type habitHotkeyDay struct {
	Day          string `json:"day"`
	TotalHotkeys int    `json:"total_hotkeys"`
}

type habitReportFile struct {
	Report struct {
		GeneratedAt string      `json:"generated_at"`
		Window      habitWindow `json:"window"`
		WorkFocus   habitFocus  `json:"work_focus"`
		Concurrency struct {
			MaxRunning int `json:"max_running"`
		} `json:"concurrency"`
		Agents struct {
			Verify  map[string]int `json:"verify"`
			Session struct {
				ActiveMinutesP50 *float64 `json:"active_minutes_p50"`
				UserTurns        int      `json:"user_turns"`
			} `json:"session"`
		} `json:"agents"`
		Hotkeys struct {
			Total int              `json:"total_hotkey_presses"`
			Daily []habitHotkeyDay `json:"daily"`
		} `json:"hotkeys"`
		Wakatime struct {
			OK     bool `json:"ok"`
			Totals struct {
				Text string `json:"text"`
			} `json:"totals"`
		} `json:"wakatime"`
	} `json:"report"`
	Markdown string `json:"markdown"`
}

func habitSnapshotDir() string {
	if override := os.Getenv("WEZDECK_HABIT_SNAPSHOT_DIR"); override != "" {
		return override
	}
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" {
		home, _ := os.UserHomeDir()
		state = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(state, "wezterm-runtime", "state", "workflow", "habit-weekly")
}

func habitReport(args json.RawMessage) (any, error) {
	var request struct {
		Period          string `json:"period"`
		IncludeMarkdown bool   `json:"include_markdown"`
	}
	if err := json.Unmarshal(args, &request); err != nil {
		return nil, err
	}
	switch request.Period {
	case "this", "last", "14d":
	default:
		return nil, errors.New("unknown habit report period")
	}
	path := filepath.Join(habitSnapshotDir(), request.Period+".json")
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		relayLogf("habit_report_read", "period=%s outcome=missing", request.Period)
		return map[string]any{"available": true, "present": false, "period": request.Period}, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Size() > 2*1024*1024 {
		return nil, errors.New("habit snapshot is too large")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var source habitReportFile
	if err := json.Unmarshal(data, &source); err != nil {
		return nil, fmt.Errorf("invalid habit snapshot: %w", err)
	}
	if source.Report.GeneratedAt == "" || source.Report.Window.Start == "" || source.Report.Window.End == "" {
		return nil, errors.New("habit snapshot is incomplete")
	}
	if source.Report.WorkFocus.Areas == nil {
		source.Report.WorkFocus.Areas = map[string]int{}
	}
	if source.Report.WorkFocus.Daily == nil {
		source.Report.WorkFocus.Daily = []habitDay{}
	}
	if source.Report.Agents.Verify == nil {
		source.Report.Agents.Verify = map[string]int{}
	}
	if source.Report.Hotkeys.Daily == nil {
		source.Report.Hotkeys.Daily = []habitHotkeyDay{}
	}
	result := map[string]any{
		"available":          true,
		"present":            true,
		"period":             request.Period,
		"generated_at":       source.Report.GeneratedAt,
		"window":             source.Report.Window,
		"work_focus":         source.Report.WorkFocus,
		"max_running":        source.Report.Concurrency.MaxRunning,
		"verify":             source.Report.Agents.Verify,
		"active_minutes_p50": source.Report.Agents.Session.ActiveMinutesP50,
		"user_turns":         source.Report.Agents.Session.UserTurns,
		"hotkeys":            source.Report.Hotkeys,
		"wakatime":           source.Report.Wakatime,
	}
	if request.IncludeMarkdown {
		result["markdown"] = source.Markdown
	}
	relayLogf("habit_report_read", "period=%s outcome=ok age_ms=%d markdown=%t",
		request.Period, time.Since(info.ModTime()).Milliseconds(), request.IncludeMarkdown)
	return result, nil
}

func habitRefresh() (any, error) {
	if _, err := habitSystemctl("start", "--no-block", habitService); err != nil {
		relayLogf("habit_refresh", "outcome=failed")
		return nil, errors.New("habit snapshot service is unavailable")
	}
	relayLogf("habit_refresh", "outcome=started")
	return map[string]any{"started": true}, nil
}
