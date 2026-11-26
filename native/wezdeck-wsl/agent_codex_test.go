package main

import (
	"reflect"
	"testing"
)

func TestCodexChatOnlyShowsUserContent(t *testing.T) {
	var tr transcript
	for _, row := range []string{
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /repo\nRules"},{"type":"input_text","text":"<environment_context>cwd</environment_context>"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["agents_md.instructions","environments.environment_context"],"content_item_metadata":[{"provenance":{"type":"agents_md"}},{"provenance":{"type":"harness"}}]}}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text"],"content_item_metadata":[{"provenance":{"type":"user"}}]}}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好！"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /example"},{"type":"input_image","image_url":"data:image/png;base64,AA=="},{"type":"input_text","text":"internal hint"},{"type":"input_text","text":"<svg />\n[网页附件]\n/tmp/image.png"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text","user.image","another.context","user.text"],"content_item_metadata":[{"provenance":{"type":"user"}},{"provenance":{"type":"user"}},{"provenance":{"type":"harness"}},{"provenance":{"type":"user"}}]}}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /old\nRules"},{"type":"input_text","text":"<environment_context>cwd</environment_context>"},{"type":"input_text","text":"<user_info>context</user_info>\n<user_query>legacy prompt</user_query>"}]}}`,
	} {
		tr.feedCodex([]byte(row))
	}
	want := []chatMessage{
		{Role: "user", Text: "hello"},
		{Role: "assistant", Text: "你好！"},
		{Role: "user", Text: "# AGENTS.md instructions for /example\n<svg />\n[网页附件]\n/tmp/image.png"},
		{Role: "user", Text: "legacy prompt"},
	}
	if !reflect.DeepEqual(tr.messages, want) {
		t.Fatalf("got %#v, want %#v", tr.messages, want)
	}
}
