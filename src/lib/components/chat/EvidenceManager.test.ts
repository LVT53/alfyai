import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import EvidenceManager from "./EvidenceManager.svelte";
import type { ContextDebugState, ContextSourcesState } from "$lib/types";

describe("EvidenceManager context source labels", () => {
	afterEach(() => {
		uiLanguage.set("en");
	});

	it("renders the conversation-level Context Sources surface in English", () => {
		const { getAllByText, getByRole, getByText } = render(EvidenceManager, {
			open: true,
			contextDebug: makeContextDebug(),
			contextSources: makeContextSources(),
		});

		expect(getByRole("dialog", { name: "Context Sources" })).toBeInTheDocument();
		expect(getByText("Manage context sources")).toBeInTheDocument();
		expect(getByText("Current sources")).toBeInTheDocument();
		expect(getByText("Active sources")).toBeInTheDocument();
		expect(getByText("Reduced")).toBeInTheDocument();
		expect(getAllByText("Context source preference").length).toBeGreaterThan(0);
		expect(getAllByText("Auto").length).toBeGreaterThan(0);
	});

	it("renders the conversation-level Context Sources surface in Hungarian", () => {
		uiLanguage.set("hu");

		const { getAllByText, getByRole, getByText } = render(EvidenceManager, {
			open: true,
			contextDebug: makeContextDebug(),
			contextSources: makeContextSources(),
		});

		expect(getByRole("dialog", { name: "Kontextusforrások" })).toBeInTheDocument();
		expect(getByText("Kontextusforrások kezelése")).toBeInTheDocument();
		expect(getByText("Jelenlegi források")).toBeInTheDocument();
		expect(getByText("Aktív források")).toBeInTheDocument();
		expect(getByText("Csökkentett")).toBeInTheDocument();
		expect(getAllByText("Kontextusforrás-preferencia").length).toBeGreaterThan(0);
		expect(getAllByText("Automatikus").length).toBeGreaterThan(0);
	});

	it("uses contextSources for conversation-level rows when available", () => {
		const { getByText } = render(EvidenceManager, {
			open: true,
			contextDebug: makeContextDebug(),
			contextSources: makeContextSources(),
		});

		expect(getByText("Planning document")).toBeInTheDocument();
		expect(getByText("Pinned source")).toBeInTheDocument();
		expect(getByText("Excluded source")).toBeInTheDocument();
	});

	it("keeps inferred task evidence out of current sources", () => {
		const { getByText } = render(EvidenceManager, {
			open: true,
			contextDebug: makeContextDebug(),
			contextSources: makeInferredOnlyContextSources(),
		});

		expect(getByText("No active context sources are selected right now.")).toBeInTheDocument();
		expect(getByText("Inferred sources")).toBeInTheDocument();
		expect(getByText("Draft reference")).toBeInTheDocument();
	});
});

function makeContextDebug(): ContextDebugState {
	return {
		activeTaskId: null,
		activeTaskObjective: null,
		taskLocked: false,
		routingStage: "deterministic",
		routingConfidence: 0,
		verificationStatus: "skipped",
		selectedEvidence: [
			{
				artifactId: "artifact-1",
				name: "Planning document",
				artifactType: "document",
				sourceType: "document",
				role: "selected",
				origin: "system",
				confidence: 0.9,
				reason: "Current task source",
			},
		],
		selectedEvidenceBySource: [{ sourceType: "document", count: 1 }],
		pinnedEvidence: [],
		excludedEvidence: [],
	};
}

function makeContextSources(): ContextSourcesState {
	return {
		conversationId: "conversation-1",
		userId: "user-1",
		activeCount: 2,
		inferredCount: 0,
		selectedCount: 1,
		pinnedCount: 1,
		excludedCount: 1,
		reduced: true,
		compacted: false,
		updatedAt: Date.now(),
		groups: [
			{
				kind: "task_evidence",
				state: "active",
				totalCount: 1,
				items: [
					{
						id: "task_evidence:artifact-1",
						artifactId: "artifact-1",
						title: "Planning document",
						state: "active",
						sourceType: "document",
						artifactType: "document",
						reason: "Current task source",
						reduced: true,
						compacted: false,
					},
				],
			},
			{
				kind: "pinned",
				state: "pinned",
				totalCount: 1,
				items: [
					{
						id: "pinned:artifact-2",
						artifactId: "artifact-2",
						title: "Pinned source",
						state: "pinned",
						sourceType: "document",
						artifactType: "document",
						reduced: true,
						compacted: false,
					},
				],
			},
			{
				kind: "excluded",
				state: "excluded",
				totalCount: 1,
				items: [
					{
						id: "excluded:artifact-3",
						artifactId: "artifact-3",
						title: "Excluded source",
						state: "excluded",
						sourceType: "document",
						artifactType: "document",
						reduced: true,
						compacted: false,
					},
				],
			},
		],
	};
}

function makeInferredOnlyContextSources(): ContextSourcesState {
	return {
		conversationId: "conversation-1",
		userId: "user-1",
		activeCount: 0,
		inferredCount: 1,
		selectedCount: 1,
		pinnedCount: 0,
		excludedCount: 0,
		reduced: false,
		compacted: false,
		updatedAt: Date.now(),
		groups: [
			{
				kind: "task_evidence",
				state: "inferred",
				totalCount: 1,
				items: [
					{
						id: "task_evidence:message-1",
						artifactId: "artifact-1",
						title: "Draft reference",
						state: "inferred",
						sourceType: "document",
						artifactType: "document",
						reason: "Referenced in selected message evidence",
						reduced: false,
						compacted: false,
					},
				],
			},
		],
	};
}
