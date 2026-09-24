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
