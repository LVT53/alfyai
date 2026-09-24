import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * "Manage context sources" removal guard.
 *
 * The surface was inert: the per-source Auto/Pinned/Excluded steering the
 * panel wrote reached `MessageBubble` as props nothing read, and the
 * Context Sources projection the ring could fall back to was already
 * computed-and-discarded on the stream path. This test fails if any of the
 * removed symbols comes back through a stale import, a re-added prop, or a
 * resurrected component after a merge.
 */
const REMOVED_SYMBOLS = [
	"EvidenceManager",
	"EvidencePreferenceControl",
	"applyTaskSteering",
	"TaskSteeringAction",
	"TaskSteeringPayload",
	"contextSources",
	"contextUsageRing.manageEvidence",
];

const FILES = [
	"src/routes/(app)/chat/[conversationId]/+page.svelte",
	"src/routes/(app)/chat/[conversationId]/+page.ts",
	"src/routes/(app)/chat/[conversationId]/_components/ChatComposerPanel.svelte",
	"src/routes/(app)/chat/[conversationId]/_components/ChatMessagePane.svelte",
	"src/lib/components/chat/MessageInput.svelte",
	"src/lib/components/chat/MessageInputWrapper.test.svelte",
	"src/lib/components/chat/MessageArea.svelte",
	"src/lib/components/chat/MessageBubble.svelte",
	"src/lib/components/chat/ContextUsageRing.svelte",
	"src/lib/client/api/conversations.ts",
];

describe("Manage context sources removal", () => {
	it.each(FILES)("keeps %s free of removed symbols", (file) => {
		const source = readFileSync(file, "utf8");
		for (const symbol of REMOVED_SYMBOLS) {
			expect(source, `${file} still mentions ${symbol}`).not.toContain(symbol);
		}
	});

	it("keeps the compaction indicator, which reads contextStatus", () => {
		const ring = readFileSync(
			"src/lib/components/chat/ContextUsageRing.svelte",
			"utf8",
		);
		expect(ring).toContain("contextStatus");
		expect(ring).toContain("compaction");
	});

	it("keeps the ring's contextDebug fallback chain", () => {
		const ring = readFileSync(
			"src/lib/components/chat/ContextUsageRing.svelte",
			"utf8",
		);
		expect(ring).toContain("contextDebug");
		expect(ring).toContain("selectedEvidence");
	});

	it("keeps the shared linked-source plumbing whole", () => {
		// The Keep table in the slice document, checked by existence and by one
		// live consumer each.
		for (const file of [
			"src/lib/server/services/linked-context-sources.ts",
			"src/lib/components/chat/LinkedDocumentPicker.svelte",
			"src/lib/components/chat/LinkedSourceManager.svelte",
		]) {
			expect(
				() => readFileSync(file, "utf8"),
				`${file} was deleted`,
			).not.toThrow();
		}
		const preflight = readFileSync(
			"src/lib/server/services/chat-turn/preflight.ts",
			"utf8",
		);
		expect(preflight).toContain("linked-context-sources");
	});

	it("keeps the linked-context-source artifact link type", () => {
		const linked = readFileSync(
			"src/lib/server/services/linked-context-sources.ts",
			"utf8",
		);
		expect(linked).toContain("linked_context_source");
	});
});

/**
 * Dead wiring left standing after the removal.
 *
 * The pinned/excluded read side outlived its writers: no row with
 * `origin = 'user'` and a pin/exclude role can be created any more, so the
 * two debug fields (and the two ring rows that gated on them) could never
 * render. They must not come back through a merge.
 */
describe("dead wiring the context-sources removal left behind", () => {
	it.each([
		"src/lib/server/services/knowledge/context-types.ts",
		"src/lib/server/services/task-state.ts",
		"src/lib/server/services/chat-turn/context-selection.ts",
		"src/lib/components/chat/ContextUsageRing.svelte",
	])("keeps %s free of the retired pin/exclude debug fields", (file) => {
		const source = readFileSync(file, "utf8");
		for (const field of ["pinnedEvidence", "excludedEvidence"]) {
			expect(source, `${file} still mentions ${field}`).not.toContain(field);
		}
	});

	it("drops the pinned/excluded ring labels with the rows they labelled", () => {
		const i18n = readFileSync("src/lib/i18n/chat.ts", "utf8");
		expect(i18n).not.toContain('"contextUsageRing.pinned"');
		expect(i18n).not.toContain('"contextUsageRing.excluded"');
	});

	it("drops the linkedSources parameter finalizeChatTurn never read", () => {
		// The parameter survived the Context Sources removal: finalizeChatTurn
		// accepted it but no step ever read it, and the stream path threaded it
		// through `CompleteStreamTurnParams` for that one dead argument.
		for (const file of [
			"src/lib/server/services/chat-turn/finalize.ts",
			"src/lib/server/services/chat-turn/stream-completion.ts",
		]) {
			expect(
				readFileSync(file, "utf8"),
				`${file} still threads linkedSources`,
			).not.toContain("linkedSources");
		}
		// The atlas artifact-link snapshot keeps its own linkedSources argument —
		// that one is read. The send route may therefore pass it exactly once;
		// the two finalizeChatTurn arguments it used to fill are gone (and would
		// no longer typecheck, since the parameter itself is removed).
		const send = readFileSync("src/routes/api/chat/send/+server.ts", "utf8");
		expect(send).not.toContain("linkedSources: turn.linkedSources,");
		expect(
			send.match(/linkedSources: atlasPreflight\.value\.linkedSources,/g),
		).toHaveLength(1);
	});
});
