package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestTodoCLIThroughRelay(t *testing.T) {
	t.Setenv("WEZDECK_TODO_DB", filepath.Join(t.TempDir(), "t.db"))
	// this package lives in a git repo, so its directory resolves to one
	added, err := runTodoCLI("add", "--cwd", ".", "--source", "web", "--", "--follow up on the relay")
	if err != nil {
		t.Fatal(err)
	}
	todo := added.(map[string]any)["todo"].(map[string]any)
	if todo["text"] != "--follow up on the relay" || todo["source"] != "web" {
		t.Fatalf("added %+v", todo)
	}
	id := int64(todo["id"].(float64))
	open, err := listTodos(json.RawMessage(`{"all":true}`))
	if err != nil || len(open.(map[string]any)["todos"].([]any)) != 1 {
		t.Fatalf("open list %+v err=%v", open, err)
	}
	args, _ := json.Marshal(map[string]any{"op": "done", "id": id})
	if _, err := writeTodo(args); err != nil {
		t.Fatal(err)
	}
	open, _ = listTodos(json.RawMessage(`{"all":true}`))
	if n := len(open.(map[string]any)["todos"].([]any)); n != 0 {
		t.Fatalf("done to-do still open (%d)", n)
	}
	if _, err := writeTodo(json.RawMessage(`{"op":"add","session":"../x","text":"x"}`)); err == nil {
		t.Fatal("a bad session id must be refused")
	}
	if _, err := writeTodo(json.RawMessage(`{"op":"rm","id":1}`)); err == nil {
		t.Fatal("unknown op must be refused")
	}
}
