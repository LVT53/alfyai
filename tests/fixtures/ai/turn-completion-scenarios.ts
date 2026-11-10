/** Synthetic turns shared by the HTTP provider and black-box browser tests. */
export const COMPLETION_MARKER = "Fake turn completion contract: ";
export const COMPLETION_WORKING = "Hello. Let me check.";
export const COMPLETION_ANSWER =
	"## Result\n\nThe checked result is **42**.\n\n- Evidence retained\n";
export const COMPLETION_USEFUL_WORKING =
	"The first calculation is 6 × 7 = 42. Let me check the filing rule.";
export const COMPLETION_EVIDENCE_TAIL =
	"Archive key: ORCHID-73. Dispatch is Tuesday.";
// The tail exceeds a short digest: continuation must keep the actual read result.
export const COMPLETION_EVIDENCE_BODY = `# Filing evidence\n\n${"Keep this complete filing record for the final answer. ".repeat(40)}\n\n${COMPLETION_EVIDENCE_TAIL}`;
export const COMPLETION_SYNTHESIS =
	"## Result\n\n6 × 7 = **42**. Archive key: **ORCHID-73**. Dispatch is **Tuesday**.";
export const COMPLETION_PARTIAL = "## Result\n\nThe checked result is";
export const COMPLETION_HOLD = "completion-final";
export const COMPLETION_ARTIFACT_TITLE = "Completion execution-once evidence";
export const COMPLETION_CALL_ID = "call_completion_read_0";
export const COMPLETION_MODES = [
	"natural",
	"tool",
	"reasoning-only",
	"length",
	"stagnation",
	"budget",
	"side-effect",
	"useful-partial",
	"closing-error",
	"closing-truncated",
	"closing-empty",
	"pause",
] as const;
export type CompletionMode = (typeof COMPLETION_MODES)[number];
export function completionMessage(mode: CompletionMode): string {
	return `${COMPLETION_MARKER}${mode}. Read completion-evidence.txt if a tool is needed, then report the result.`;
}
