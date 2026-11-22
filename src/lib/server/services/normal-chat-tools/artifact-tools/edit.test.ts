import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactDetail } from "$lib/server/services/artifacts";
import {
	PATCH_OP_KINDS,
	patchOpInputSchema,
} from "$lib/shared/artifact-document/patch";
import {
	EDIT_ARTIFACT_APP_EXAMPLE,
	EDIT_ARTIFACT_DOCUMENT_EXAMPLE,
} from "./kind-prose";

const getArtifactMock =
	vi.fn<
		(params: {
			userId: string;
			artifactId: string;
			conversationId?: string | null;
		}) => Promise<ArtifactDetail | null>
	>();
const listArtifactCatalogueEntriesMock =
	vi.fn<
		(params: { userId: string; conversationId: string }) => Promise<
			Array<{
				artifactId: string;
				artifactType: string;
				title: string;
				updatedAt: number;
			}>
		>
	>();

vi.mock("$lib/server/services/artifacts", () => ({
	getArtifact: (...args: unknown[]) => getArtifactMock(...(args as [never])),
	listArtifactCatalogueEntries: (...args: unknown[]) =>
		listArtifactCatalogueEntriesMock(...(args as [never])),
}));

// F2 (ruling 77): an App is changed by the panel's own rebuild, the one function
// both the route and this tool call; its generation and checks have tests of
// their own (artifacts/app/regenerate.test.ts).
const regenerateAppMock = vi.fn();
vi.mock("$lib/server/services/artifacts/app/regenerate", () => ({
	regenerateApp: (...args: unknown[]) => regenerateAppMock(...args),
}));

const {
	buildEditArtifactModelInputSchema,
	documentPatchesArraySchema,
	EDIT_ARTIFACT_HANDLERS,
	editArtifactInputSchema,
	MAX_APP_REBUILDS_PER_TURN,
	runEditArtifactTool,
} = await import("./edit");
// The tests below take handlers away to see what a kind with none does; the App's
// own is the one under test in its describe block, so it is kept from before.
const REAL_APP_HANDLER = EDIT_ARTIFACT_HANDLERS.app;

function detail(overrides: Partial<ArtifactDetail> = {}): ArtifactDetail {
	return {
		id: "artifact-1",
		kind: "document",
		title: "Vienna plan",
		conversationId: "conv-1",
		versionNumber: 1,
		commentCount: 0,
		updatedAt: Date.now(),
		body: "# Plan\ncontent",
		bodyHash: "hash-1",
		metadata: { artifactType: "document", title: "Vienna plan" },
		...overrides,
	};
}

afterEach(() => {
	getArtifactMock.mockReset();
	listArtifactCatalogueEntriesMock.mockReset();
	regenerateAppMock.mockReset();
	delete EDIT_ARTIFACT_HANDLERS.document;
	delete EDIT_ARTIFACT_HANDLERS.app;
});

describe("editArtifactInputSchema", () => {
	it("caps patches and ops at 40", () => {
		const tooMany = {
			artifactId: "a",
			ops: Array.from({ length: 41 }, () => ({})),
		};
		expect(editArtifactInputSchema.safeParse(tooMany).success).toBe(false);
	});
});

// A dev live check (2026-09-26) found edit_artifact's Document op contract
// undiscoverable: the advertised schema never showed the real `op` values, so
// the model guessed seven wrong synonyms in a row (insert_after, replace,
// update, edit, update_block — never one of the five real ops) and gave up.
// The fix makes `patchOpInputSchema` (patch.ts) the ONE schema both the
// advertised description/schema and this handler's own validator read; these
// pin that the two really are the same schema, not two that happen to agree
// today.
describe("edit_artifact's Document op contract (dev incident, 2026-09-26)", () => {
	it("the description's own worked example parses through the real validator", () => {
		const result = documentPatchesArraySchema.safeParse(
			EDIT_ARTIFACT_DOCUMENT_EXAMPLE.patches,
		);
		expect(result.success).toBe(true);
	});

	it.each([
		{
			op: "replaceBlock",
			blockId: "b1",
			baseHash: "h1",
			text: "New text.",
		},
		{
			op: "insertText",
			blockId: "b1",
			baseHash: "h1",
			text: "More text.",
			at: "end",
		},
		{
			op: "replaceRange",
			blockId: "b1",
			baseHash: "h1",
			find: "old",
			text: "new",
		},
		{ op: "toggleTask", blockId: "b1", baseHash: "h1", checked: true },
		{
			op: "addTableRow",
			blockId: "b1",
			baseHash: "h1",
			cells: ["a", "b"],
		},
	])(
		"the advertised union accepts a real $op example with exactly its fields",
		(example) => {
			expect(patchOpInputSchema.safeParse(example).success).toBe(true);
		},
	);

	it("PATCH_OP_KINDS lists exactly the five ops the schema's own discriminant accepts", () => {
		expect(PATCH_OP_KINDS).toEqual([
			"replaceBlock",
			"insertText",
			"replaceRange",
			"toggleTask",
			"addTableRow",
		]);
	});

	it("refuses an op name outside the union — the exact guess the real model made on dev", () => {
		const result = patchOpInputSchema.safeParse({
			op: "insert_after",
			blockId: "b1",
			baseHash: "h1",
			text: "x",
		});
		expect(result.success).toBe(false);
	});
});

describe("runEditArtifactTool — structural validation", () => {
	it("refuses when neither patches nor ops is present", async () => {
		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		expect(getArtifactMock).not.toHaveBeenCalled();
		expect(result.metadata).toEqual({
			ok: false,
			reasonCode: "request_adjusted",
		});
	});

	it("refuses when both patches and ops are present", async () => {
		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{}],
			ops: [{}],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		expect(getArtifactMock).not.toHaveBeenCalled();
		// The words the model reads are the words it always read.
		expect(result.modelPayload).toEqual({
			success: false,
			error: "Send patches or ops, never both in the same call.",
		});
		expect(result.metadata).toEqual({
			ok: false,
			reasonCode: "request_adjusted",
		});
	});
});

describe("runEditArtifactTool — id resolution", () => {
	it("returns candidates and refuses when the id is not in this conversation", async () => {
		getArtifactMock.mockResolvedValue(null);
		listArtifactCatalogueEntriesMock.mockResolvedValue([
			{
				artifactId: "a1",
				artifactType: "document",
				title: "Other plan",
				updatedAt: 1,
			},
		]);

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "missing-id",
			patches: [{ op: "replace" }],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.candidates).toEqual([
				{ artifactId: "a1", title: "Other plan" },
			]);
		}
		expect(result.metadata).toEqual({
			ok: false,
			found: false,
			reasonCode: "item_not_found",
		});
	});

	it("never edits another user's artifact (delegates ownership to getArtifact)", async () => {
		getArtifactMock.mockResolvedValue(null);
		listArtifactCatalogueEntriesMock.mockResolvedValue([]);

		await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "replace" }],
			abortSignal: new AbortController().signal,
		});

		expect(getArtifactMock).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1", conversationId: "conv-1" }),
		);
	});
});

describe("runEditArtifactTool — no kind registered yet (Slice 5a)", () => {
	it("refuses a Document edit with an unsupported_kind reason the model can act on", async () => {
		getArtifactMock.mockResolvedValue(detail({ kind: "document" }));

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "replace" }],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.refused).toEqual([
				{ target: "artifact-1", reason: "unsupported_kind" },
			]);
			expect(result.modelPayload.error.length).toBeGreaterThan(0);
		}
		// No handler for the kind: the row says the kind cannot be edited.
		expect(result.metadata).toMatchObject({
			ok: false,
			reasonCode: "kind_not_editable",
		});
	});

	it("refuses a picture edit and points at make_image", async () => {
		getArtifactMock.mockResolvedValue(
			detail({ id: "img-1", kind: "image", title: "Cosy room" }),
		);

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "img-1",
			patches: [{ op: "replace" }],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.error).toContain(
				'make_image (pictures: ["img-1"])',
			);
			expect(result.modelPayload.refused).toEqual([
				{ target: "img-1", reason: "unsupported_kind" },
			]);
		}
		expect(result.metadata.ok).toBe(false);
		expect(result.metadata.reasonCode).toBe("not_editable_as_text");
	});

	it("points an instruction edit of a picture at make_image, not at patches", async () => {
		getArtifactMock.mockResolvedValue(
			detail({ id: "img-1", kind: "image", title: "Cosy room" }),
		);

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "img-1",
			instruction: "make it warmer",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.error).toContain(
				'make_image (pictures: ["img-1"])',
			);
			expect(result.modelPayload.error).not.toContain("Apps only");
		}
	});

	it("refuses a video edit and says a video is made by asking for one", async () => {
		getArtifactMock.mockResolvedValue(
			detail({ id: "vid-1", kind: "video", title: "Harbour at dusk" }),
		);

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "vid-1",
			patches: [{ op: "replace" }],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.error).toBe(
				"Videos are not edited as text. A video is made by asking for one.",
			);
			expect(result.modelPayload.refused).toEqual([
				{ target: "vid-1", reason: "unsupported_kind" },
			]);
		}
		expect(result.metadata).toMatchObject({
			ok: false,
			artifactKind: "video",
			reasonCode: "not_editable_as_text",
		});
	});

	it("refuses a File edit — files are produced, not edited", async () => {
		getArtifactMock.mockResolvedValue(
			detail({ kind: "file", title: "Trip.pdf" }),
		);

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "replace" }],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		expect(result.metadata.reasonCode).toBe("not_editable_as_text");
	});
});

// A call that did not work names why from edit_artifact's closed list of
// reasons, on the entry's metadata: a code a handler gave, or the one a call in
// which every op was turned back as stale earns. The model reads what it read.
describe("runEditArtifactTool — the reason a call did not work", () => {
	const run = (
		overrides: Partial<Parameters<typeof runEditArtifactTool>[0]> = {},
	) =>
		runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "a" }],
			abortSignal: new AbortController().signal,
			...overrides,
		});

	it("names a refusal with the code its handler gave, beside a payload that does not say so", async () => {
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: false,
			error: "Documents use patches, not ops.",
			code: "request_adjusted",
		});

		const result = await run();

		expect(result.modelPayload).toEqual({
			success: false,
			error: "Documents use patches, not ops.",
		});
		expect(JSON.stringify(result.modelPayload)).not.toContain(
			"request_adjusted",
		);
		expect(result.metadata).toMatchObject({
			ok: false,
			reasonCode: "request_adjusted",
		});
	});

	it("names nothing for a refusal its handler gave no code for", async () => {
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: false,
			error: "This document could not be found.",
		});

		const result = await run();

		expect(result.metadata).not.toHaveProperty("reasonCode");
	});

	it("names a call that changed nothing because every op was stale changed_since_read, op by op as before", async () => {
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: false,
			error: "Nothing was changed: every op was refused.",
			refused: [
				{ target: "b1", reason: "stale" as const, opIndex: 0 },
				{ target: "b2", reason: "stale" as const, opIndex: 1 },
			],
		});

		const result = await run();

		expect(result.metadata).toMatchObject({
			ok: false,
			reasonCode: "changed_since_read",
		});
		// refusedBlocksJson is as it was.
		expect(JSON.parse(String(result.metadata.refusedBlocksJson))).toEqual([
			{ blockId: "b1", reason: "stale", opIndex: 0 },
			{ blockId: "b2", reason: "stale", opIndex: 1 },
		]);
	});

	it("names nothing when one of the refused ops was refused for another reason", async () => {
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: false,
			error: "Nothing was changed: every op was refused.",
			refused: [
				{ target: "b1", reason: "stale" as const, opIndex: 0 },
				{ target: "b2", reason: "unknown_id" as const, opIndex: 1 },
			],
		});

		const result = await run();

		expect(result.metadata).not.toHaveProperty("reasonCode");
	});

	it("names a Document edit that applied nothing because every op was changed since the read changed_since_read, and it stays a success", async () => {
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: true,
			value: {
				versionId: "version-1",
				applied: 0,
				refused: [
					{ target: "b1", reason: "block_changed" as const, opIndex: 0 },
				],
			},
		});

		const result = await run();

		expect(result.modelPayload).toMatchObject({ success: true, applied: 0 });
		expect(result.metadata).toMatchObject({
			ok: true,
			appliedCount: 0,
			reasonCode: "changed_since_read",
		});
		expect(JSON.parse(String(result.metadata.refusedBlocksJson))).toEqual([
			{ blockId: "b1", reason: "block_changed", opIndex: 0 },
		]);
	});

	it("names nothing for an edit that applied something, or one that applied nothing for another reason", async () => {
		getArtifactMock.mockResolvedValue(detail());
		const stale = {
			target: "b1",
			reason: "block_changed" as const,
			opIndex: 0,
		};

		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: true,
			value: { versionId: "version-1", applied: 1, refused: [stale] },
		});
		expect(await run()).toMatchObject({ metadata: { ok: true } });
		expect((await run()).metadata).not.toHaveProperty("reasonCode");

		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: true,
			value: {
				versionId: "version-1",
				applied: 0,
				refused: [
					{ target: "b1", reason: "block_missing" as const, opIndex: 0 },
				],
			},
		});
		expect((await run()).metadata).not.toHaveProperty("reasonCode");
	});
});

describe("runEditArtifactTool — a registered handler", () => {
	it("applies a patch batch and returns the version id, with one refusal per refused op", async () => {
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: true,
			value: {
				versionId: "version-2",
				applied: 2,
				refused: [{ target: "block-3", reason: "unsupported_kind" as const }],
			},
		});

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "a" }, { op: "b" }, { op: "c" }],
			summary: "Moved the errand block",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload).toEqual({
			success: true,
			artifactId: "artifact-1",
			versionId: "version-2",
			applied: 2,
			refused: [{ target: "block-3", reason: "unsupported_kind" }],
		});
		expect(result.metadata).toEqual({
			ok: true,
			artifactId: "artifact-1",
			artifactKind: "document",
			artifactTitle: "Vienna plan",
			// Ruling 76: the call's record names the version it wrote, so History's
			// "From the chat" can find the message behind an Alfy moment.
			versionId: "version-2",
			appliedCount: 2,
			refusedBlocksJson: JSON.stringify([
				{ blockId: "block-3", reason: "unsupported_kind" },
			]),
		});
	});

	// T8 live: the browser never sees the full server PatchResult (no
	// inverses, no per-op outcomes) for a live edit_artifact call — only this
	// metadata bag. `refusedBlocksJson` is what an open Document panel
	// reconstructs its refusal notice from (see `document/alfy-activity.ts`),
	// so its shape (an array of plain `{blockId, reason}`, JSON-encoded
	// because `metadata` values must stay flat scalars) is load-bearing.
	it("omits refusedBlocksJson when nothing was refused", async () => {
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: true,
			value: { versionId: "version-2", applied: 3, refused: [] },
		});

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "a" }, { op: "b" }, { op: "c" }],
			summary: "Moved the errand block",
			abortSignal: new AbortController().signal,
		});

		expect(result.metadata.appliedCount).toBe(3);
		expect(result.metadata).not.toHaveProperty("refusedBlocksJson");
	});

	it("records the summary is passed through to the handler as the version's description", async () => {
		getArtifactMock.mockResolvedValue(detail());
		const handler = vi.fn(async () => ({
			ok: true as const,
			value: { versionId: "version-2", applied: 1, refused: [] },
		}));
		EDIT_ARTIFACT_HANDLERS.document = handler;

		await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "a" }],
			summary: "Moved the errand block",
			abortSignal: new AbortController().signal,
		});

		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ summary: "Moved the errand block" }),
		);
	});

	it("passes its own abortSignal through to a registered handler unchanged", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async (params) => {
			seenSignal = params.abortSignal;
			return {
				ok: true,
				value: { versionId: "version-2", applied: 1, refused: [] },
			};
		};

		await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "a" }],
			abortSignal: controller.signal,
		});

		expect(seenSignal).toBe(controller.signal);
	});
});

// F2 (ruling 77): "change this App" in the chat changes THAT App, through the
// same rebuild the panel's "Módosítás…" runs, as one new Alfy version. Before
// this the tool told the model Apps are not edited here, so it made a second App
// of the same name and the open panel kept showing the old one.
describe("edit_artifact on an App (F2, ruling 77)", () => {
	const rebuilt = {
		ok: true as const,
		version: 2,
		versionId: "version-2",
		title: "Tip calculator",
		verification: { checked: true, verdict: "clean" as const, reason: null },
	};
	const appDetail = () =>
		detail({ kind: "app", title: "Tip calculator", versionNumber: 1 });

	function run(
		overrides: Partial<Parameters<typeof runEditArtifactTool>[0]> = {},
	) {
		EDIT_ARTIFACT_HANDLERS.app = REAL_APP_HANDLER;
		return runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			instruction: "Make the background dark and add a Reset button",
			abortSignal: new AbortController().signal,
			...overrides,
		});
	}

	it("rebuilds the App in place through the panel's own rebuild, and answers with the version it wrote", async () => {
		getArtifactMock.mockResolvedValue(appDetail());
		regenerateAppMock.mockResolvedValue(rebuilt);
		const controller = new AbortController();

		const result = await run({
			abortSignal: controller.signal,
		});

		expect(regenerateAppMock).toHaveBeenCalledTimes(1);
		expect(regenerateAppMock).toHaveBeenCalledWith({
			userId: "user-1",
			artifactId: "artifact-1",
			conversationId: "conv-1",
			prompt: "Make the background dark and add a Reset button",
			abortSignal: controller.signal,
		});
		expect(result.modelPayload).toEqual({
			success: true,
			artifactId: "artifact-1",
			versionId: "version-2",
			applied: 1,
			refused: [],
			note: expect.stringContaining("nothing is still pending"),
		});
		// The record carries what History's "From the chat" and the open panel need.
		expect(result.metadata).toMatchObject({
			ok: true,
			artifactId: "artifact-1",
			artifactKind: "app",
			artifactTitle: "Tip calculator",
			versionId: "version-2",
		});
		expect(result.outputSummary).toContain("Tip calculator");
	});

	// Found by the live check: told "takes about a minute", the real model answered a
	// finished rebuild with "the rebuild may take about a minute, then you will see
	// the new look". The call returns when the rebuild is done, and says so.
	it("tells the model the rebuild is finished and on screen, so it does not promise a wait", async () => {
		getArtifactMock.mockResolvedValue(appDetail());
		regenerateAppMock.mockResolvedValue(rebuilt);

		const result = await run();

		expect(result.modelPayload.success).toBe(true);
		if (result.modelPayload.success) {
			expect(result.modelPayload.note).toMatch(/has been rebuilt/);
			expect(result.modelPayload.note).toMatch(/open now/);
		}
	});

	it("needs no baseHash, no patches and no read first: the instruction is the whole call", async () => {
		getArtifactMock.mockResolvedValue(appDetail());
		regenerateAppMock.mockResolvedValue(rebuilt);

		const result = await run({ patches: undefined, ops: undefined });

		expect(result.modelPayload.success).toBe(true);
	});

	it("refuses patches or ops for an App, naming the field that works, and rebuilds nothing", async () => {
		getArtifactMock.mockResolvedValue(appDetail());

		for (const sent of [{ ops: [{ op: "update_node" }] }, { patches: [{}] }]) {
			const result = await run({ instruction: undefined, ...sent });
			expect(result.modelPayload.success).toBe(false);
			if (!result.modelPayload.success) {
				expect(result.modelPayload.error).toContain("instruction");
				expect(result.modelPayload.error.toLowerCase()).not.toContain(
					"new app",
				);
			}
			expect(result.metadata.reasonCode).toBe("request_adjusted");
		}
		expect(regenerateAppMock).not.toHaveBeenCalled();
	});

	it("refuses an instruction sent beside patches or ops: one shape per call", async () => {
		const result = await run({ ops: [{ op: "move" }] });

		expect(result.modelPayload.success).toBe(false);
		expect(getArtifactMock).not.toHaveBeenCalled();
		expect(regenerateAppMock).not.toHaveBeenCalled();
		expect(result.metadata.reasonCode).toBe("request_adjusted");
	});

	it("refuses an instruction for a Document or a board, naming what those take", async () => {
		for (const [kind, field] of [
			["document", "patches"],
			["canvas", "ops"],
		] as const) {
			getArtifactMock.mockResolvedValue(detail({ kind }));
			const result = await run();
			expect(result.modelPayload.success).toBe(false);
			if (!result.modelPayload.success) {
				expect(result.modelPayload.error).toContain(field);
				expect(result.modelPayload.error).toMatch(/App/);
			}
			expect(result.metadata.reasonCode).toBe("request_adjusted");
		}
		expect(regenerateAppMock).not.toHaveBeenCalled();
	});

	it("says what failed and that the App is unchanged, and never invites a second App", async () => {
		getArtifactMock.mockResolvedValue(appDetail());
		regenerateAppMock.mockResolvedValue({
			ok: false,
			reason: "no_fence",
			detail: "the answer did not contain a runnable app",
		});

		const result = await run();

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.error).toContain("could not be rebuilt");
			expect(result.modelPayload.error).toContain("unchanged");
			expect(result.modelPayload.error).toMatch(/do not make a new App/i);
		}
		// The chat's row for the refused call names the item by its title (RC-A #2): it
		// used to say "Tool <id>" and print the call's parameters.
		expect(result.metadata).toMatchObject({
			ok: false,
			artifactId: "artifact-1",
			artifactKind: "app",
			artifactTitle: "Tip calculator",
		});
		// A rebuild that failed is no request to correct: the row has no code for it.
		expect(result.metadata).not.toHaveProperty("reasonCode");
	});

	it("reports an App that changed while it was rebuilt, with the version it is at now", async () => {
		getArtifactMock.mockResolvedValue(appDetail());
		regenerateAppMock.mockResolvedValue({
			ok: false,
			reason: "version_conflict",
			version: 3,
		});

		const result = await run();

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.error).toContain("version 3");
			expect(result.modelPayload.error).toContain("Nothing was written");
		}
		// They saved while it was being built: their words were left as they were.
		expect(result.metadata.reasonCode).toBe("changed_since_read");
	});

	it("names a rebuild that was cancelled while it ran a stop", async () => {
		getArtifactMock.mockResolvedValue(appDetail());
		regenerateAppMock.mockResolvedValue({
			ok: false,
			reason: "aborted",
			detail: "the call was aborted",
		});

		const result = await run();

		expect(result.modelPayload).toMatchObject({
			success: false,
			error: "The request was cancelled.",
		});
		expect(result.metadata.reasonCode).toBe("stopped");
	});

	it("writes nothing for a call that was cancelled (ruling 53)", async () => {
		getArtifactMock.mockResolvedValue(appDetail());
		const controller = new AbortController();
		controller.abort();

		const result = await run({ abortSignal: controller.signal });

		expect(result.modelPayload.success).toBe(false);
		expect(regenerateAppMock).not.toHaveBeenCalled();
		expect(result.metadata.reasonCode).toBe("stopped");
	});

	it("rebuilds at most MAX_APP_REBUILDS_PER_TURN times in one turn: a rebuild costs a model call", async () => {
		getArtifactMock.mockResolvedValue(appDetail());
		regenerateAppMock.mockResolvedValue(rebuilt);
		const budget = { used: 0 };
		const turnContext = { sources: [], appRebuildBudget: budget };

		const results = [];
		for (let call = 0; call <= MAX_APP_REBUILDS_PER_TURN; call += 1) {
			results.push(await run({ turnContext }));
		}

		expect(regenerateAppMock).toHaveBeenCalledTimes(MAX_APP_REBUILDS_PER_TURN);
		const refused = results[MAX_APP_REBUILDS_PER_TURN].modelPayload;
		expect(refused.success).toBe(false);
		if (!refused.success) {
			expect(refused.error).toMatch(/limit/i);
			expect(refused.error).toMatch(/tell the user/i);
		}
		// Only the call past the limit is named; the two that ran have no code.
		expect(results[MAX_APP_REBUILDS_PER_TURN].metadata.reasonCode).toBe(
			"rebuild_limit_reached",
		);
		expect(results[0].metadata).not.toHaveProperty("reasonCode");
	});
});

// Ruling 62: what the tool advertises is what its validator parses.
describe("edit_artifact's App contract (ruling 62)", () => {
	it("the description's own worked example parses through the executed schema and the advertised one", () => {
		expect(
			editArtifactInputSchema.safeParse(EDIT_ARTIFACT_APP_EXAMPLE).success,
		).toBe(true);
		expect(
			buildEditArtifactModelInputSchema([
				"document",
				"app",
				"canvas",
			]).safeParse(EDIT_ARTIFACT_APP_EXAMPLE).success,
		).toBe(true);
	});

	it("advertises `instruction` for Apps, and the validator bounds it", () => {
		const shown = buildEditArtifactModelInputSchema(["document", "app"]);
		expect(shown.shape.instruction.description).toMatch(/App/);
		expect(
			editArtifactInputSchema.safeParse({ artifactId: "a", instruction: "" })
				.success,
		).toBe(false);
		expect(
			editArtifactInputSchema.safeParse({
				artifactId: "a",
				instruction: "x".repeat(4001),
			}).success,
		).toBe(false);
	});

	it("does not advertise `instruction` while no App can be made", () => {
		const shown = buildEditArtifactModelInputSchema(["document"]);
		expect(shown.shape.instruction.description ?? "").not.toMatch(/App/);
	});
});
