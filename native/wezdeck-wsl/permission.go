package main

// What a permission prompt is about, for the phone (no screen reading).
// While the attention entry is waiting with waiting_kind=permission_prompt,
// the call the agent is blocked on is the newest tool call in the
// transcript with no result yet. The phone shows it — the command, the diff,
// or for ExitPlanMode the plan — with the answers whose keys do not depend
// on what else the dialog offers: 1 (the first "Yes") and Esc ("No, and
// tell Claude what to do differently" / "No, keep planning"). The middle
// options ("don't ask again", the plan's edit modes) vary by tool and mode,
// so the phone does not guess them.

type pendingCall struct {
	Tool string `json:"tool"`
	Text string `json:"text"`           // "<tool> <target>" (toolSummary)
	Body string `json:"body,omitempty"` // command / diff / plan (toolBody)
	File string `json:"file,omitempty"`
	Plan bool   `json:"plan,omitempty"` // ExitPlanMode: the body is the plan
}

// planTool: the agent's plan-approving tool (planReader.PlanTool), "" none.
func pendingPermission(messages []chatMessage, planTool string) *pendingCall {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if m.Role != "tool" || !m.Pending {
			continue
		}
		if m.Tool == "AskUserQuestion" {
			return nil // a question, answered by the elicitation card
		}
		return &pendingCall{Tool: m.Tool, Text: m.Text, Body: m.Body, File: m.File, Plan: planTool != "" && m.Tool == planTool}
	}
	return nil
}
