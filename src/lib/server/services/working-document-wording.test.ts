import { describe, expect, it } from "vitest";
import type { Artifact } from "./knowledge/types";
import { resolveWorkingDocumentSelection } from "./working-document-selection";
import { englishWordingRecord } from "./working-document-wording.test-helpers";

const document: Artifact = {
	id: "doc-1",
	userId: "user-1",
	type: "generated_output",
	retrievalClass: "durable",
	name: "doc-1.md",
	mimeType: "text/markdown",
	sizeBytes: 100,
	conversationId: "conv-1",
	summary: null,
	createdAt: 1,
	updatedAt: 1,
	extension: "md",
	storagePath: null,
	contentText: null,
	metadata: {
		documentFamilyId: "family-1",
		documentLabel: "Draft",
		versionNumber: 1,
	},
};
export function selection(message: string) {
	return resolveWorkingDocumentSelection({
		message,
		activeDocumentArtifactId: document.id,
		currentConversationId: "conv-1",
		artifacts: [document],
	});
}
describe("English wording recorded before Hungarian support", () => {
	it.each(englishWordingRecord)("preserves %s", (message, expected) => {
		const s = selection(message);
		const effects = {
			focus: s.activeFocus.artifactIds.length > 0,
			docFocused: s.documentFocused,
			correction: s.correction.hasSignal,
			reset: s.reset.hasSignal,
			newDoc: s.retrieval.suppressGeneratedCarryover && !s.reset.hasSignal,
		};
		expect(
			Object.entries(effects)
				.filter(([, v]) => v)
				.map(([k]) => k),
		).toEqual(expected);
	});
});
