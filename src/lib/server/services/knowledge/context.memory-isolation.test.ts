import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import { isAutomaticEvidenceInConversation } from "./automatic-generated-evidence";
import type { Artifact } from "./types";

const { rerankItems } = vi.hoisted(() => ({
	rerankItems: vi.fn(async (_params: { items: Artifact[] }) => null),
}));

vi.mock("../tei-reranker", () => ({
	canUseTeiReranker: () => true,
	rerankItems,
}));

let harness: EngineHarness;
beforeEach(async () => {
	harness = await bootEngine("generated-evidence-memory-isolation");
	rerankItems.mockClear();
});
afterEach(() => harness.cleanup());

const query =
	"What is the name of my touring kayak and the project workshop workbench?";
const current = "current-recreation";
const source = "source-workshop";
const historical = "derived-recreation";
const sourceId = "workshop-answer";
const copiedId = "earlier-contaminated-answer";
const documentId = "authorized-library-document";
const currentId = "current-output";

it("requires a known source and target conversation for automatic answer reuse", () => {
	expect(
		isAutomaticEvidenceInConversation(
			{ type: "generated_output", conversationId: "" },
			"",
		),
	).toBe(false);
	expect(
		isAutomaticEvidenceInConversation(
			{ type: "generated_output", conversationId: null },
			current,
		),
	).toBe(false);
});

async function seedEvidence(
	account: "hindsight" | "preparing" | "rolled_back" | "legacy" | "absent",
) {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const userId = harness.userId;
	db.insert(schema.projects)
		.values([
			{ id: "workshop", userId, name: "Workshop" },
			{ id: "recreation", userId, name: "Recreation" },
		])
		.run();
	db.insert(schema.conversations)
		.values([
			{
				id: current,
				userId,
				projectId: "recreation",
				title: "Current recreation",
			},
			{ id: source, userId, projectId: "workshop", title: "Source workshop" },
			{
				id: historical,
				userId,
				projectId: "recreation",
				title: "Previous recreation",
			},
		])
		.run();
	db.insert(schema.artifacts)
		.values([
			{
				id: sourceId,
				userId,
				conversationId: source,
				type: "generated_output",
				name: "Touring kayak and project workbench result",
				contentText:
					"The project workshop workbench is code-named GLASS-QUASAR.",
			},
			{
				id: copiedId,
				userId,
				conversationId: historical,
				type: "generated_output",
				name: "Touring kayak and project workbench result",
				contentText:
					"A previous answer copied the project workshop workbench name GLASS-QUASAR.",
			},
			{
				id: documentId,
				userId,
				type: "normalized_document",
				name: "Touring kayak and project workshop checklist",
				contentText:
					"A library checklist for the touring kayak and the project workshop workbench.",
			},
			{
				id: currentId,
				userId,
				conversationId: current,
				type: "generated_output",
				name: "Current conversation workbench result",
				contentText: "The current conversation has a saved workbench result.",
			},
		])
		.run();
	if (account === "absent") return;
	db.insert(schema.memoryAccounts)
		.values({
			userId,
			tenantId: "memory-fixture",
			authority: account === "rolled_back" ? "legacy" : account,
		})
		.run();
	if (account === "rolled_back") {
		db.insert(schema.memoryMigrationManifests)
			.values({
				id: "prior-native-cutover",
				userId,
				epoch: 0,
				status: "complete",
				manifestJson: "{}",
				checkpointJson: JSON.stringify({
					cutoverAt: "2026-11-18T00:00:00.000Z",
				}),
			})
			.run();
	}
}

async function search() {
	const { findRelevantKnowledgeArtifacts } = await import("./context");
	return findRelevantKnowledgeArtifacts({
		userId: harness.userId,
		query,
		currentConversationId: current,
		excludeConversationId: current,
		preferredArtifactId: sourceId,
	});
}

it.each(["hindsight", "preparing", "rolled_back"] as const)(
	"keeps generated answers out of both the reranker and the other chat with %s Memory",
	async (account) => {
		await seedEvidence(account);
		const results = await search();
		expect(results.map((artifact) => artifact.id)).toContain(documentId);
		const seenByReranker = rerankItems.mock.calls.flatMap(([{ items }]) =>
			items.map((artifact) => artifact.id),
		);
		expect(seenByReranker).not.toContain(sourceId);
		expect(seenByReranker).not.toContain(copiedId);
		expect(results.map((artifact) => artifact.id)).not.toContain(sourceId);
		expect(results.map((artifact) => artifact.id)).not.toContain(copiedId);
	},
);

it("discards foreign cached working-set answers while retaining the active answer in this chat", async () => {
	await seedEvidence("hindsight");
	const { db } = await import("$lib/server/db");
	const { conversationWorkingSetItems } = await import("$lib/server/db/schema");
	db.insert(conversationWorkingSetItems)
		.values(
			[sourceId, copiedId, currentId].map((artifactId) => ({
				id: `working-${artifactId}`,
				userId: harness.userId,
				conversationId: current,
				artifactId,
				artifactType: "generated_output",
				state: "active",
				reasonCodesJson: JSON.stringify(["latest_generated_output"]),
			})),
		)
		.run();
	const { selectWorkingSetArtifactsForPrompt } = await import("./context");
	const selected = await selectWorkingSetArtifactsForPrompt(
		harness.userId,
		current,
		query,
		[],
		currentId,
	);
	expect(selected.map((artifact) => artifact.id)).toEqual([currentId]);
});

it.each(["legacy", "absent"] as const)(
	"keeps generated answer retrieval for the %s legacy account",
	async (account) => {
		await seedEvidence(account);
		const results = await search();
		expect(results.map((artifact) => artifact.id)).toContain(sourceId);
		expect(
			rerankItems.mock.calls.flatMap(([{ items }]) =>
				items.map((artifact) => artifact.id),
			),
		).toContain(sourceId);
	},
);
