// Regenerate for a deleted Document or App (polish G2-A): make it again from
// the model's own arguments, which the chat kept on the message that made it,
// under the id its cards already carry. Real migrated SQLite; only the App's
// model-backed generator is faked (the Document path is real end to end).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	NOW,
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const createAppFromBrief = vi.fn();
vi.mock("$lib/server/services/artifacts/app/create", () => ({
	createAppFromBrief: (params: unknown) => createAppFromBrief(params),
}));

const { getArtifact, deleteArtifact } = await import(
	"$lib/server/services/artifacts"
);
const { CREATE_ARTIFACT_HANDLERS } = await import("./create");
const { recreateArtifactFromStoredCall } = await import("./recreate");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-1";
const STRANGER_CONVERSATION = "conv-stranger";

let sequence = 0;
function seedCreateCall(params: {
	artifactId: string;
	input: Record<string, unknown>;
	conversationId?: string;
	ok?: boolean;
}): string {
	sequence += 1;
	const id = `message-${sequence}`;
	memory.db
		.insert(schema.messages)
		.values({
			id,
			conversationId: params.conversationId ?? CONVERSATION,
			messageSequence: sequence,
			role: "assistant",
			content: "I made it.",
			toolCalls: JSON.stringify([
				{
					type: "tool_call",
					callId: `call-${sequence}`,
					name: "create_artifact",
					input: params.input,
					status: "done",
					metadata: {
						ok: params.ok ?? true,
						artifactId: params.artifactId,
						artifactKind: params.input.artifactType as string,
						artifactTitle: params.input.title as string,
					},
				},
			]),
			createdAt: NOW,
		})
		.run();
	return id;
}

const DOCUMENT_INPUT = {
	artifactType: "document",
	title: "Weekend in Vienna",
	body: "# Weekend\n\n- [ ] Book the train",
};

function regenerate(
	overrides: Partial<Parameters<typeof recreateArtifactFromStoredCall>[0]> = {},
) {
	return recreateArtifactFromStoredCall({
		userId: OWNER,
		conversationId: CONVERSATION,
		artifactId: "doc-1",
		language: "en",
		abortSignal: new AbortController().signal,
		...overrides,
	});
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	sequence = 0;
	createAppFromBrief.mockReset();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, { id: STRANGER_CONVERSATION, userId: STRANGER });
});

describe("recreateArtifactFromStoredCall", () => {
	it("makes a deleted Document again from the stored call, under the id its cards carry", async () => {
		seedCreateCall({ artifactId: "doc-1", input: DOCUMENT_INPUT });

		const result = await regenerate();

		expect(result).toEqual({
			ok: true,
			created: true,
			artifactId: "doc-1",
			kind: "document",
			title: "Weekend in Vienna",
		});
		const artifact = await getArtifact({
			userId: OWNER,
			artifactId: "doc-1",
			conversationId: CONVERSATION,
		});
		expect(artifact).toMatchObject({
			id: "doc-1",
			kind: "document",
			title: "Weekend in Vienna",
			conversationId: CONVERSATION,
			versionNumber: 1,
		});
		expect(artifact?.body).toContain("Book the train");
	});

	it("does nothing when the item exists again already, and says so", async () => {
		seedCreateCall({ artifactId: "doc-1", input: DOCUMENT_INPUT });
		await regenerate();
		const before = await getArtifact({ userId: OWNER, artifactId: "doc-1" });

		const again = await regenerate();

		expect(again).toMatchObject({
			ok: true,
			created: false,
			artifactId: "doc-1",
		});
		const after = await getArtifact({ userId: OWNER, artifactId: "doc-1" });
		expect(after?.versionNumber).toBe(before?.versionNumber);
	});

	it("brings a deleted Document back after a delete, from the same call", async () => {
		seedCreateCall({ artifactId: "doc-1", input: DOCUMENT_INPUT });
		await regenerate();
		await deleteArtifact({ userId: OWNER, artifactId: "doc-1" });
		expect(
			await getArtifact({ userId: OWNER, artifactId: "doc-1" }),
		).toBeNull();

		const result = await regenerate();

		expect(result).toMatchObject({
			ok: true,
			created: true,
			artifactId: "doc-1",
		});
		expect(
			await getArtifact({ userId: OWNER, artifactId: "doc-1" }),
		).not.toBeNull();
	});

	it("makes a deleted App again from its stored brief through the App generator, keeping the id", async () => {
		seedCreateCall({
			artifactId: "app-1",
			input: {
				artifactType: "app",
				title: "Trip budget",
				body: "Split trip costs between three friends.",
			},
		});
		createAppFromBrief.mockResolvedValue({
			ok: true,
			artifactId: "app-1",
			title: "Trip budget splitter",
			verification: { checked: false, verdict: "clean", reason: null },
		});

		const result = await regenerate({ artifactId: "app-1", language: "hu" });

		expect(createAppFromBrief).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: OWNER,
				conversationId: CONVERSATION,
				prompt: "Split trip costs between three friends.",
				title: "Trip budget",
				language: "hu",
				artifactId: "app-1",
			}),
		);
		expect(result).toEqual({
			ok: true,
			created: true,
			artifactId: "app-1",
			kind: "app",
			title: "Trip budget splitter",
		});
	});

	it("reports an App the generator could not make, and creates nothing", async () => {
		seedCreateCall({
			artifactId: "app-1",
			input: {
				artifactType: "app",
				title: "Trip budget",
				body: "Split costs.",
			},
		});
		createAppFromBrief.mockResolvedValue({
			ok: false,
			reason: "not_saved",
			detail: "could not save the app",
		});

		await expect(regenerate({ artifactId: "app-1" })).resolves.toMatchObject({
			ok: false,
			reason: "failed",
		});
	});

	it("says there is nothing to make it from when no create call of this chat names it", async () => {
		// Only an EDIT names the id: it holds a summary, not the item.
		memory.db
			.insert(schema.messages)
			.values({
				id: "message-edit",
				conversationId: CONVERSATION,
				messageSequence: 99,
				role: "assistant",
				content: "Edited.",
				toolCalls: JSON.stringify([
					{
						type: "tool_call",
						name: "edit_artifact",
						input: { artifactId: "doc-1", summary: "Tightened" },
						status: "done",
						metadata: { ok: true, artifactId: "doc-1" },
					},
				]),
				createdAt: NOW,
			})
			.run();

		await expect(regenerate()).resolves.toEqual({
			ok: false,
			reason: "no_stored_input",
		});
		await expect(regenerate({ artifactId: "never-made" })).resolves.toEqual({
			ok: false,
			reason: "no_stored_input",
		});
	});

	it("will not make an item from a stored call whose arguments are no longer valid", async () => {
		seedCreateCall({
			artifactId: "doc-1",
			input: { artifactType: "file", title: "x", body: "y" },
		});

		await expect(regenerate()).resolves.toEqual({
			ok: false,
			reason: "no_stored_input",
		});
	});

	it("answers like a missing chat for a conversation that is not the caller's", async () => {
		seedCreateCall({
			artifactId: "doc-9",
			conversationId: STRANGER_CONVERSATION,
			input: DOCUMENT_INPUT,
		});

		await expect(
			regenerate({
				artifactId: "doc-9",
				conversationId: STRANGER_CONVERSATION,
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		await expect(
			regenerate({ artifactId: "doc-9", conversationId: "no-such-chat" }),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		expect(
			await getArtifact({ userId: STRANGER, artifactId: "doc-9" }),
		).toBeNull();
	});

	it("never overwrites someone else's row that happens to hold the id", async () => {
		seedCreateCall({ artifactId: "doc-1", input: DOCUMENT_INPUT });
		// Another user's document under that very id.
		memory.db
			.insert(schema.artifacts)
			.values({
				id: "doc-1",
				userId: STRANGER,
				conversationId: STRANGER_CONVERSATION,
				type: "artifact",
				retrievalClass: "durable",
				name: "Theirs",
				contentText: "Their text",
				metadataJson: JSON.stringify({
					artifactType: "document",
					title: "Theirs",
				}),
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();

		await expect(regenerate()).resolves.toMatchObject({
			ok: false,
			reason: "failed",
		});
		const theirs = memory.db
			.select()
			.from(schema.artifacts)
			.all()
			.find((row) => row.id === "doc-1");
		expect(theirs).toMatchObject({ userId: STRANGER, name: "Theirs" });
	});

	it("runs one regeneration of an item at a time", async () => {
		seedCreateCall({
			artifactId: "slides-1",
			input: { artifactType: "slides", title: "Deck", body: "{}" },
		});
		let release: () => void = () => {};
		CREATE_ARTIFACT_HANDLERS.slides = () =>
			new Promise((resolve) => {
				release = () =>
					resolve({
						ok: true,
						value: { artifactId: "slides-1", title: "Deck" },
					});
			});
		try {
			const first = regenerate({ artifactId: "slides-1" });
			// Let the first call reach its (pending) handler.
			await vi.waitFor(() => expect(release).not.toBe(undefined));
			await new Promise((resolve) => setTimeout(resolve, 20));

			await expect(regenerate({ artifactId: "slides-1" })).resolves.toEqual({
				ok: false,
				reason: "in_progress",
			});

			release();
			await expect(first).resolves.toMatchObject({ ok: true, created: true });
		} finally {
			delete CREATE_ARTIFACT_HANDLERS.slides;
		}
	});

	it("writes nothing when the caller already gave up", async () => {
		seedCreateCall({ artifactId: "doc-1", input: DOCUMENT_INPUT });
		const controller = new AbortController();
		controller.abort();

		await expect(
			regenerate({ abortSignal: controller.signal }),
		).resolves.toMatchObject({ ok: false, reason: "failed" });
		expect(
			await getArtifact({ userId: OWNER, artifactId: "doc-1" }),
		).toBeNull();
	});
});
