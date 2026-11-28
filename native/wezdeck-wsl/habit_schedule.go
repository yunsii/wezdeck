package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

const habitTimer = "wezdeck-habit-snapshot.timer"
const habitService = "wezdeck-habit-snapshot.service"

var habitTimePattern = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
var defaultHabitTimes = []string{"09:00", "12:30", "18:30"}

func habitUnitDir() string {
	if override := os.Getenv("WEZDECK_HABIT_SYSTEMD_DIR"); override != "" {
		return override
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "systemd", "user")
}

func habitOverridePath() string {
	return filepath.Join(habitUnitDir(), habitTimer+".d", "schedule.conf")
}

func habitSystemctl(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	binary := os.Getenv("WEZDECK_HABIT_SYSTEMCTL")
	if binary == "" {
		if os.Getenv("WEZDECK_HABIT_SYSTEMD_DIR") != "" {
			return "", errors.New("habit timer test command unavailable")
		}
		binary = "systemctl"
	}
	command := exec.CommandContext(ctx, binary, append([]string{"--user"}, args...)...)
	out, err := command.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func habitSystemdTime(raw string) string {
	if raw == "" || raw == "n/a" {
		return ""
	}
	parsed, err := time.Parse("Mon 2006-01-02 15:04:05 -07", raw)
	if err != nil {
		return raw
	}
	return parsed.Format(time.RFC3339)
}

func habitTimes() ([]string, error) {
	data, err := os.ReadFile(habitOverridePath())
	if errors.Is(err, os.ErrNotExist) {
		return append([]string(nil), defaultHabitTimes...), nil
	}
	if err != nil {
		return nil, err
	}
	var times []string
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "OnCalendar=*-*-* ") {
			continue
		}
		value := strings.TrimPrefix(line, "OnCalendar=*-*-* ")
		if !strings.HasSuffix(value, ":00 Asia/Singapore") {
			return nil, errors.New("unknown habit timer override")
		}
		times = append(times, strings.TrimSuffix(value, ":00 Asia/Singapore"))
	}
	if len(times) != 3 {
		return nil, errors.New("unknown habit timer override")
	}
	return times, nil
}

func habitScheduleStatus() (any, error) {
	times, err := habitTimes()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(habitUnitDir(), habitTimer)); errors.Is(err, os.ErrNotExist) {
		return map[string]any{"installed": false, "enabled": false, "times": times}, nil
	} else if err != nil {
		return nil, err
	}
	enabledOutput, _ := habitSystemctl("is-enabled", habitTimer)
	timerOutput, err := habitSystemctl("show", habitTimer,
		"-p", "ActiveState", "-p", "NextElapseUSecRealtime", "-p", "LastTriggerUSec")
	if err != nil {
		return nil, errors.New("habit timer status unavailable")
	}
	serviceOutput, _ := habitSystemctl("show", habitService, "-p", "Result")
	properties := map[string]string{}
	for _, line := range strings.Split(timerOutput+"\n"+serviceOutput, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			properties[key] = value
		}
	}
	return map[string]any{
		"installed":    true,
		"enabled":      enabledOutput == "enabled",
		"times":        times,
		"active":       properties["ActiveState"] == "active",
		"next_run":     habitSystemdTime(properties["NextElapseUSecRealtime"]),
		"last_trigger": habitSystemdTime(properties["LastTriggerUSec"]),
		"last_result":  properties["Result"],
	}, nil
}

func writeHabitTimes(times []string) error {
	if len(times) != 3 {
		return errors.New("three daily times are required")
	}
	seen := map[string]bool{}
	for _, value := range times {
		if !habitTimePattern.MatchString(value) || seen[value] {
			return errors.New("invalid or repeated habit refresh time")
		}
		seen[value] = true
	}
	sort.Strings(times)
	path := habitOverridePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	old, readErr := os.ReadFile(path)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	lines := []string{"[Timer]", "OnCalendar="}
	for _, value := range times {
		lines = append(lines, "OnCalendar=*-*-* "+value+":00 Asia/Singapore")
	}
	if err := writeHabitOverride(path, []byte(strings.Join(lines, "\n")+"\n")); err != nil {
		return err
	}
	_, reloadErr := habitSystemctl("daemon-reload")
	if reloadErr == nil {
		_, reloadErr = habitSystemctl("try-restart", habitTimer)
	}
	if reloadErr == nil {
		return nil
	}
	if readErr == nil {
		_ = writeHabitOverride(path, old)
	} else {
		_ = os.Remove(path)
	}
	_, _ = habitSystemctl("daemon-reload")
	_, _ = habitSystemctl("try-restart", habitTimer)
	return errors.New("habit timer update failed")
}

func writeHabitOverride(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".schedule-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func habitScheduleUpdate(args json.RawMessage) (any, error) {
	var request struct {
		Op      string   `json:"op"`
		Times   []string `json:"times"`
		Enabled *bool    `json:"enabled"`
	}
	if err := json.Unmarshal(args, &request); err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(habitUnitDir(), habitTimer)); err != nil {
		return nil, errors.New("habit timer is not installed")
	}
	lock, err := os.OpenFile(filepath.Join(habitUnitDir(), ".habit-schedule.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return nil, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	switch request.Op {
	case "set_times":
		if err := writeHabitTimes(request.Times); err != nil {
			return nil, err
		}
	case "set_enabled":
		if request.Enabled == nil {
			return nil, errors.New("enabled is required")
		}
		action := "disable"
		if *request.Enabled {
			action = "enable"
		}
		if _, err := habitSystemctl(action, "--now", habitTimer); err != nil {
			return nil, errors.New("habit timer state change failed")
		}
	case "run_now":
		if _, err := habitRefresh(); err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("unknown habit timer operation")
	}
	relayLogf("habit_schedule", "op=%s outcome=ok", request.Op)
	return habitScheduleStatus()
}
