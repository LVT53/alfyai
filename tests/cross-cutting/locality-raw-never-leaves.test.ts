// Issue X.3 — CONSOLIDATED, STANDING "raw connector data never leaves the
// box" suite (Option A / locality).
//
// GUARANTEE: under Option A (local-model distillation) + a cloud model,
// PROVABLY ABSENT raw connector payloads from any cloud-model-bound
// prompt/payload — for every connector READ tool AND the 8.1 proactive
// in-chat context stage. "Absent" is checked the strong way, per existing
// per-tool precedent: `JSON.stringify(outcome.modelPayload)` must not
// contain the raw token ANYWHERE (not just the obvious field — citations are
// a proven historical leak vector, see calendar's C1 finding referenced in
// its own test file), while the Sources-tab `candidates` (a separate,
// user-facing-only channel) may retain the real values.
//
// This file REUSES each tool's own established Option-A test pattern
// (calendar.test.ts, email.test.ts, files.test.ts, photos.test.ts,
// media.test.ts, location.test.ts, contacts.test.ts) — the per-tool files
// remain the deep, exhaustive suites; this file is the single, durable,
// "every read tool has ONE locality assertion" table so a newly added
// connector read tool can't quietly skip Option A.
//
// PLUS the two REQUIRED 8.1 tests (closing Important gaps flagged by the 8.1
// review — the invariants already hold by inspection; these PIN them):
//   - I1 whole-outbound-context locality: not just the injected block in
//     isolation, but the WHOLE assembled outbound context string
//     (`prepareOutboundChatContext`'s `inputValue`) never carries a raw
//     connector token.
//   - I2 no-memory-fact / memory boundary: a turn that injects proactive
//     connector context creates NO memory fact and never threads that
//     content into the memory-judge/summary pipeline (`runPostTurnTasks`,
//     now in chat-turn/finalize-steps.ts).
import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createModelCapabilitySet } from "$lib/model-capabilities";
import type { ConnectionPublic } from "$lib/server/services/connections/store";

// ---------------------------------------------------------------------------
// Distinctive-token helper — a token that could ONLY have come from raw
// connector data (never from a distilled summary, a citation label, or any
// other model-facing text this suite doesn't control). Each locality test
// seeds its raw fixture with one of these and asserts it is provably absent
// from the model-facing payload.
// ---------------------------------------------------------------------------
let tokenCounter = 0;
function distinctiveToken(label: string): string {
	tokenCounter += 1;
	return `RAW-${label.toUpperCase()}-TOKEN-${tokenCounter}-DO-NOT-LEAK`;
}

// ---------------------------------------------------------------------------
// Shared mocks — every connector read module + the shared locality gate +
// resolve + a stubbed pending-writes (never exercised by read actions, kept
// mocked purely so importing a tool module never pulls in the real
// `$lib/server/db` transitively). connector-distill.ts is DELIBERATELY left
// REAL everywhere in this file (both the 7 tool sections and the 8.1
// section) — it's the shared "should we distill" gate every one of these
// code paths actually goes through in production; only its own primitives
// (hasLocalDistillEnabled/isCloudModel/distillConnectorPayload) are mocked.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
	resolveConnectionsForCapability: vi.fn(),
	needsDisambiguation: vi.fn(),
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
	createPendingWrite: vi.fn(),
	googleListEvents: vi.fn(),
	googleFreeBusy: vi.fn(),
	googleGetEvent: vi.fn(),
	appleListEvents: vi.fn(),
	appleGetEventByUid: vi.fn(),
	imapListRecent: vi.fn(),
	imapSearch: vi.fn(),
	imapReadMessage: vi.fn(),
	nextcloudSearch: vi.fn(),
	nextcloudReadFile: vi.fn(),
	nextcloudStat: vi.fn(),
	executeNextcloudWrite: vi.fn(),
	immichSmartSearch: vi.fn(),
	immichThumbnail: vi.fn(),
	modelIdCanSeeImages: vi.fn(),
	describeImage: vi.fn(),
	prepareImageForModel: vi.fn(),
	resolveNormalChatModelRunProvider: vi.fn(),
	plexWatchHistory: vi.fn(),
	plexLibrarySections: vi.fn(),
	owntracksLastLocation: vi.fn(),
	owntracksLocationHistory: vi.fn(),
	resolveContacts: vi.fn(),
	getConnectionSecret: vi.fn(),
	touchConnectionUsed: vi.fn().mockResolvedValue(undefined),
	// 8.1 proactive-context-stage-specific + finalize (memory boundary)
	buildConstructedContext: vi.fn(),
	getConfig: vi.fn(),
	getSystemPrompt: vi.fn(),
	getLatestValidContextCompressionSnapshot: vi.fn(),
	listContextCompressionSourceMessages: vi.fn(),
	runContextCompression: vi.fn(),
	isConversationIncognito: vi.fn(),
	isMemoryActiveForConversation: vi.fn(),
	isUserMemoryEnabled: vi.fn(),
	detectExplicitMemoryRequest: vi.fn(),
	scheduleConversationJudge: vi.fn(),
	runMemoryJudgeOnSegment: vi.fn(),
	countUnjudgedMessages: vi.fn(),
	markMemoryDirty: vi.fn(),
	refreshConversationSummary: vi.fn(),
	runUserMemoryMaintenance: vi.fn(),
}));

// selectConnection/pickDefaultConnection are kept as their REAL (pure)
// implementations — only resolveConnectionsForCapability/needsDisambiguation
// (which touch the DB) are mocked, same posture as every per-tool test file
// after the multi-connection disambiguation change.
// This test drives each tool's core directly, outside the envelope a real call
// runs in, to look at what a summary leaves in the payload. The mark the
// envelope carries is not what it is about (connector-distill.test.ts and
// shared.test.ts hold it), and a summary asked for with no call to mark is
// refused (ADR-0068), so the call is stood in for.
vi.mock(
	"$lib/server/services/normal-chat-tools/shared",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("$lib/server/services/normal-chat-tools/shared")
		>()),
		isInsideToolCall: () => true,
		markCallLocallyDistilled: vi.fn(),
	}),
);

vi.mock("$lib/server/services/connections/resolve", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/resolve")
	>("$lib/server/services/connections/resolve");
	return {
		...actual,
		resolveConnectionsForCapability: mocks.resolveConnectionsForCapability,
		needsDisambiguation: mocks.needsDisambiguation,
	};
});
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: mocks.hasLocalDistillEnabled,
	isCloudModel: mocks.isCloudModel,
	distillConnectorPayload: mocks.distillConnectorPayload,
}));
vi.mock("$lib/server/services/connections/pending-writes", () => ({
	createPendingWrite: mocks.createPendingWrite,
}));
vi.mock(
	"$lib/server/services/connections/providers/google-calendar",
	async () => {
		const actual = await vi.importActual<
			typeof import("$lib/server/services/connections/providers/google-calendar")
		>("$lib/server/services/connections/providers/google-calendar");
		return {
			...actual,
			googleListEvents: mocks.googleListEvents,
			googleFreeBusy: mocks.googleFreeBusy,
			googleGetEvent: mocks.googleGetEvent,
		};
	},
);
vi.mock("$lib/server/services/connections/providers/apple-caldav", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/apple-caldav")
	>("$lib/server/services/connections/providers/apple-caldav");
	return {
		...actual,
		appleListEvents: mocks.appleListEvents,
		appleGetEventByUid: mocks.appleGetEventByUid,
	};
});
vi.mock("$lib/server/services/connections/providers/imap", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/imap")
	>("$lib/server/services/connections/providers/imap");
	return {
		...actual,
		imapListRecent: mocks.imapListRecent,
		imapSearch: mocks.imapSearch,
		imapReadMessage: mocks.imapReadMessage,
	};
});
vi.mock(
	"$lib/server/services/connections/providers/nextcloud-files",
	async () => {
		const actual = await vi.importActual<
			typeof import("$lib/server/services/connections/providers/nextcloud-files")
		>("$lib/server/services/connections/providers/nextcloud-files");
		return {
			...actual,
			nextcloudSearch: mocks.nextcloudSearch,
			nextcloudReadFile: mocks.nextcloudReadFile,
			nextcloudStat: mocks.nextcloudStat,
			executeNextcloudWrite: mocks.executeNextcloudWrite,
		};
	},
);
vi.mock("$lib/server/services/connections/providers/immich", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/immich")
	>("$lib/server/services/connections/providers/immich");
	return {
		...actual,
		immichSmartSearch: mocks.immichSmartSearch,
		immichThumbnail: mocks.immichThumbnail,
	};
});
// What a look at Immich photos reaches for beyond the download: whether a model
// can see, the describing call, the image preparation, and where the summarising
// model runs. The decision about who gets pixels is the code under test, so
// connections/locality (above) and these are the only edges that are faked.
vi.mock("$lib/server/services/vision/model-vision", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("$lib/server/services/vision/model-vision")
	>()),
	modelIdCanSeeImages: mocks.modelIdCanSeeImages,
}));
vi.mock("$lib/server/services/vision/describe", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("$lib/server/services/vision/describe")
	>()),
	describeImage: mocks.describeImage,
}));
vi.mock(
	"$lib/server/services/vision/prepare-image",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("$lib/server/services/vision/prepare-image")
		>()),
		prepareImageForModel: mocks.prepareImageForModel,
	}),
);
vi.mock("$lib/server/services/normal-chat-model", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("$lib/server/services/normal-chat-model")
	>()),
	resolveNormalChatModelRunProvider: mocks.resolveNormalChatModelRunProvider,
}));
vi.mock("$lib/server/services/connections/providers/plex", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/plex")
	>("$lib/server/services/connections/providers/plex");
	return {
		...actual,
		plexWatchHistory: mocks.plexWatchHistory,
		plexLibrarySections: mocks.plexLibrarySections,
	};
});
vi.mock("$lib/server/services/connections/providers/owntracks", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/owntracks")
	>("$lib/server/services/connections/providers/owntracks");
	return {
		...actual,
		owntracksLastLocation: mocks.owntracksLastLocation,
		owntracksLocationHistory: mocks.owntracksLocationHistory,
	};
});
vi.mock("$lib/server/services/connections/providers/contacts", () => ({
	resolveContacts: mocks.resolveContacts,
}));
// Full replacement (not importActual) — matches files.test.ts's own
// convention exactly. Nothing in this file seeds real store data (every
// connection comes from the mocked resolveConnectionsForCapability above),
// so the real store.ts (and its `$lib/server/db` import chain) is never
// needed and must never load here.
vi.mock("$lib/server/services/connections/store", () => ({
	getConnectionSecret: mocks.getConnectionSecret,
	// capability-read.ts marks a connection as used on every successful read
	// (fire-and-forget, so the tool never fails on it). This suite mocks the
	// store wholesale, so the export has to be here or the tool throws before
	// it ever builds the payload these tests inspect.
	touchConnectionUsed: mocks.touchConnectionUsed,
}));

// --- 8.1 proactive-context-stage + memory-boundary deps ---
vi.mock("$lib/server/config-store", () => ({
	getConfig: mocks.getConfig,
}));
vi.mock("$lib/server/prompts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/prompts")>();
	return { ...actual, getSystemPrompt: mocks.getSystemPrompt };
});
vi.mock("$lib/server/services/chat-turn/context-selection", () => ({
	buildConstructedContext: mocks.buildConstructedContext,
}));
vi.mock("$lib/server/services/context-compression", () => ({
	getLatestValidContextCompressionSnapshot:
		mocks.getLatestValidContextCompressionSnapshot,
	listContextCompressionSourceMessages:
		mocks.listContextCompressionSourceMessages,
	runContextCompression: mocks.runContextCompression,
}));
vi.mock("$lib/server/services/memory-controls", () => ({
	isConversationIncognito: mocks.isConversationIncognito,
	isMemoryActiveForConversation: mocks.isMemoryActiveForConversation,
	isUserMemoryEnabled: mocks.isUserMemoryEnabled,
}));

// --- finalize.ts's full static-import surface (I2 memory-boundary test) ---
vi.mock("$lib/server/services/chat-files", () => ({
	syncGeneratedFilesToMemory: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/services/analytics", () => ({
	recordMessageAnalytics: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/services/messages", () => ({
	createMessage: vi.fn(async () => ({ id: "message-1" })),
	listMessages: vi.fn(async () => []),
	updateMessageEvidence: vi.fn(async () => undefined),
	updateMessageWebCitationAudit: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/services/conversation-drafts", () => ({
	clearConversationDraft: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/services/conversation-summaries", () => ({
	refreshConversationSummary: mocks.refreshConversationSummary,
}));
vi.mock("$lib/server/services/memory-judge/runner", () => ({
	detectExplicitMemoryRequest: mocks.detectExplicitMemoryRequest,
	scheduleConversationJudge: mocks.scheduleConversationJudge,
}));
vi.mock("$lib/server/services/memory-judge", () => ({
	runMemoryJudgeOnSegment: mocks.runMemoryJudgeOnSegment,
}));
vi.mock("$lib/server/services/memory-judge/segment", () => ({
	countUnjudgedMessages: mocks.countUnjudgedMessages,
}));
vi.mock("$lib/server/services/memory-profile/dirty-ledger", () => ({
	markMemoryDirty: mocks.markMemoryDirty,
}));
vi.mock("$lib/server/services/knowledge", () => ({
	attachArtifactsToMessage: vi.fn(async () => undefined),
	createGeneratedOutputArtifact: vi.fn(async () => null),
	getArtifactsForUser: vi.fn(async () => []),
	getConversationWorkingSet: vi.fn(async () => []),
	listConversationSourceArtifactIds: vi.fn(async () => []),
	refreshConversationWorkingSet: vi.fn(async () => []),
	upsertWorkCapsule: vi.fn(async () => null),
}));
vi.mock("$lib/server/services/knowledge/store", () => ({
	parseWorkingDocumentMetadata: vi.fn(() => ({})),
}));
vi.mock("$lib/server/services/memory-behavior-log", () => ({
	recordMemoryBehaviorEvent: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/services/memory-maintenance", () => ({
	runUserMemoryMaintenance: mocks.runUserMemoryMaintenance,
}));
vi.mock("$lib/server/services/memory-profile/reset-generation", () => ({
	isCurrentMemoryResetGeneration: vi.fn(async () => true),
}));
vi.mock("$lib/server/services/message-evidence", () => ({
	buildAssistantEvidenceSummary: vi.fn(async () => null),
}));
vi.mock("$lib/server/services/skills/notes", () => ({
	commitSkillNoteOperationsAfterAssistantMessage: vi.fn(async () => null),
}));
vi.mock("$lib/server/services/skills/sessions", () => ({
	applySkillControlOperations: vi.fn(async () => null),
}));
vi.mock("$lib/server/services/task-state", () => ({
	applyProjectContinuitySignalFromMessage: vi.fn(async () => undefined),
	shouldTrackTaskContinuityFromTurn: vi.fn(() => false),
	attachContinuityToTaskState: vi.fn(async (_userId, taskState) => taskState),
	getContextDebugState: vi.fn(async () => null),
	getConversationTaskState: vi.fn(async () => null),
	getProjectReferenceContext: vi.fn(async () => null),
	syncTaskContinuityFromTaskState: vi.fn(async () => undefined),
	updateTaskStateCheckpoint: vi.fn(async () => null),
}));
vi.mock("$lib/server/services/web-citation-audit", () => ({
	buildWebCitationAudit: vi.fn(() => null),
}));
vi.mock("$lib/server/services/working-document-selection", () => ({
	resolveWorkingDocumentSelection: vi.fn(async () => null),
}));

function makeConn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "google",
		label: "Connector",
		accountIdentifier: "alice@example.com",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["calendar"],
		config: {},
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function resetSharedMocks() {
	mocks.resolveConnectionsForCapability.mockReset();
	mocks.needsDisambiguation.mockReset();
	mocks.needsDisambiguation.mockReturnValue(false);
	mocks.hasLocalDistillEnabled.mockReset();
	mocks.isCloudModel.mockReset();
	mocks.distillConnectorPayload.mockReset();
}

// ---------------------------------------------------------------------------
// Table-driven per-tool locality assertions. Each block: seed a connected
// connection + ONE raw record carrying a distinctive token, run the tool
// twice (Option A off, and Option A on + cloud model + distilled), and
// assert the token's fate.
// ---------------------------------------------------------------------------

describe("locality — calendar (Option A)", () => {
	beforeEach(resetSharedMocks);

	it("Option A off: raw event title flows into modelPayload", async () => {
		const token = distinctiveToken("calendar-title");
		mocks.resolveConnectionsForCapability.mockResolvedValue([makeConn()]);
		mocks.googleListEvents.mockResolvedValue([
			{
				id: "evt-1",
				summary: token,
				start: "2026-07-09T09:00:00Z",
				end: "2026-07-09T09:30:00Z",
				htmlLink: "https://calendar.google.com/evt-1",
			},
		]);
		mocks.hasLocalDistillEnabled.mockResolvedValue(false);
		mocks.isCloudModel.mockResolvedValue(true);

		const { runCalendarTool } = await import(
			"$lib/server/services/normal-chat-tools/calendar"
		);
		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			"model1",
		);
		expect(JSON.stringify(outcome.modelPayload)).toContain(token);
	});

	it("Option A on + cloud model: raw event title is provably absent from JSON.stringify(modelPayload); candidates keep it", async () => {
		const token = distinctiveToken("calendar-title");
		mocks.resolveConnectionsForCapability.mockResolvedValue([makeConn()]);
		mocks.googleListEvents.mockResolvedValue([
			{
				id: "evt-1",
				summary: token,
				start: "2026-07-09T09:00:00Z",
				end: "2026-07-09T09:30:00Z",
				htmlLink: "https://calendar.google.com/evt-1",
			},
		]);
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.distillConnectorPayload.mockResolvedValue({
			distilled: "One event this morning.",
		});

		const { runCalendarTool } = await import(
			"$lib/server/services/normal-chat-tools/calendar"
		);
		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(true);
		expect(JSON.stringify(outcome.modelPayload)).not.toContain(token);
		expect(JSON.stringify(outcome.candidates)).toContain(token);
	});
});

describe("locality — email (Option A)", () => {
	beforeEach(resetSharedMocks);

	it("Option A on + cloud model: raw subject is provably absent from JSON.stringify(modelPayload); candidates keep it", async () => {
		const token = distinctiveToken("email-subject");
		mocks.resolveConnectionsForCapability.mockResolvedValue([
			makeConn({ provider: "imap", capabilities: ["email"] }),
		]);
		mocks.imapListRecent.mockResolvedValue([
			{
				uid: 1,
				from: "Alice <alice@example.com>",
				subject: token,
				date: "2026-07-09T08:00:00.000Z",
				seen: false,
			},
		]);
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.distillConnectorPayload.mockResolvedValue({
			distilled: "One unread message.",
		});

		const { runEmailTool } = await import(
			"$lib/server/services/normal-chat-tools/email"
		);
		const outcome = await runEmailTool(
			"user-1",
			{ action: "recent" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(true);
		expect(JSON.stringify(outcome.modelPayload)).not.toContain(token);
		expect(JSON.stringify(outcome.candidates)).toContain(token);
	});
});

describe("locality — files (Option A)", () => {
	beforeEach(resetSharedMocks);

	it("Option A on + cloud model: raw file content is provably absent from JSON.stringify(modelPayload)", async () => {
		const token = distinctiveToken("file-content");
		mocks.resolveConnectionsForCapability.mockResolvedValue([
			makeConn({ provider: "nextcloud", capabilities: ["files"] }),
		]);
		mocks.getConnectionSecret.mockReset();
		mocks.getConnectionSecret.mockResolvedValue("secret");
		mocks.nextcloudReadFile.mockResolvedValue({
			bytes: new TextEncoder().encode(token),
			etag: "etag-1",
			contentType: "text/plain",
		});
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.distillConnectorPayload.mockResolvedValue({
			distilled: "A short document.",
		});

		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			"user-1",
			{ action: "read", path: "notes/x.txt" },
			"model1",
		);
		// Sanity: the tool actually succeeded and went through distillation —
		// guards against a vacuous pass (e.g. an early refusal whose payload
		// trivially never contains the token either).
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.message).toContain("A short document.");
		expect(mocks.distillConnectorPayload).toHaveBeenCalled();
		expect(JSON.stringify(outcome.modelPayload)).not.toContain(token);
	});
});

describe("locality — photos (Option A)", () => {
	beforeEach(resetSharedMocks);

	it("Option A on + cloud model: raw photo filename is provably absent from JSON.stringify(modelPayload); candidates keep it", async () => {
		const token = distinctiveToken("photo-filename");
		mocks.resolveConnectionsForCapability.mockResolvedValue([
			makeConn({ provider: "immich", capabilities: ["photos"] }),
		]);
		mocks.immichSmartSearch.mockResolvedValue([
			{
				id: "asset-1",
				fileName: token,
				takenAt: "2026-06-01T09:55:00.000Z",
				type: "IMAGE",
				thumbnailPath: "/api/assets/asset-1/thumbnail",
			},
		]);
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.distillConnectorPayload.mockResolvedValue({
			distilled: "One photo.",
		});

		const { runPhotosTool } = await import(
			"$lib/server/services/normal-chat-tools/photos"
		);
		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "x" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(true);
		expect(JSON.stringify(outcome.modelPayload)).not.toContain(token);
		expect(JSON.stringify(outcome.candidates)).toContain(token);
	});
});

// ---------------------------------------------------------------------------
// The pixels of a photo are raw connector data too. The photos tool can show
// the model thumbnails of what it found (look: true), and for a person who keeps
// summarising local with a cloud model that must never happen: the cloud model
// is sent no thumbnail, and nothing a local model read off one except through
// the summary. The cloud model's whole input from the tool is two things: the
// tool result (modelPayload) and the pictures queued for the step after it (the
// queue), so both are searched, for the bytes and for what a local model said.
// ---------------------------------------------------------------------------
describe("locality — photos look (pixels)", () => {
	const CLOUD_CHAT_MODEL = "provider:cloud:chat";
	const LOCAL_SEEING_MODEL = "model2";
	const localProvider = {
		id: "local",
		name: "local",
		displayName: "Local",
		baseUrl: "http://192.168.1.96:30000/v1",
		modelName: "flash-next",
		apiKey: "key",
	};

	let thumbnailToken: string;
	let descriptionToken: string;
	let fileNameToken: string;

	beforeEach(() => {
		resetSharedMocks();
		for (const mock of [
			mocks.immichSmartSearch,
			mocks.immichThumbnail,
			mocks.modelIdCanSeeImages,
			mocks.describeImage,
			mocks.prepareImageForModel,
			mocks.resolveNormalChatModelRunProvider,
			mocks.getConfig,
		]) {
			mock.mockReset();
		}
		thumbnailToken = distinctiveToken("thumbnail-bytes");
		descriptionToken = distinctiveToken("local-description");
		fileNameToken = distinctiveToken("photo-filename");
		mocks.resolveConnectionsForCapability.mockResolvedValue([
			makeConn({ provider: "immich", capabilities: ["photos"] }),
		]);
		mocks.immichSmartSearch.mockResolvedValue(
			[1, 2, 3].map((n) => ({
				id: `asset-${n}`,
				fileName: `${fileNameToken}-${n}.jpg`,
				takenAt: "2026-06-01T09:55:00.000Z",
				type: "IMAGE",
				thumbnailPath: `/api/assets/asset-${n}/thumbnail`,
			})),
		);
		mocks.immichThumbnail.mockResolvedValue({
			bytes: new TextEncoder().encode(thumbnailToken).buffer,
			contentType: "image/webp",
		});
		mocks.prepareImageForModel.mockImplementation(
			async (bytes: Uint8Array) => ({
				base64: Buffer.from(bytes).toString("base64"),
				mediaType: "image/jpeg",
				width: 64,
				height: 48,
				estimatedTokens: 6,
			}),
		);
		mocks.describeImage.mockResolvedValue(`a beach ${descriptionToken}`);
		mocks.getConfig.mockReturnValue({
			memoryConsolidationModel: LOCAL_SEEING_MODEL,
		});
		mocks.resolveNormalChatModelRunProvider.mockResolvedValue(localProvider);
		mocks.distillConnectorPayload.mockResolvedValue({
			distilled: "Three beach photos.",
		});
	});

	async function lookAs(modelId: string) {
		const { runPhotosTool } = await import(
			"$lib/server/services/normal-chat-tools/photos"
		);
		const { createStepImageQueue } = await import(
			"$lib/server/services/vision/step-images"
		);
		const queue = createStepImageQueue();
		const outcome = await runPhotosTool(
			"user-1",
			{ action: "search", query: "x", look: true },
			modelId,
			undefined,
			{ queue },
		);
		// Everything the chat model is sent because of this call.
		const sentToModel = JSON.stringify([outcome.modelPayload, queue.drain()]);
		return { outcome, sentToModel };
	}

	const thumbnailBase64 = () => Buffer.from(thumbnailToken).toString("base64");

	it("Option A on + cloud model + no local model that can see: no thumbnail is downloaded, none reaches the cloud model", async () => {
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockImplementation(
			async (id: string) => id === CLOUD_CHAT_MODEL,
		);
		mocks.modelIdCanSeeImages.mockResolvedValue(false);

		const { sentToModel } = await lookAs(CLOUD_CHAT_MODEL);

		expect(mocks.immichThumbnail).not.toHaveBeenCalled();
		expect(mocks.describeImage).not.toHaveBeenCalled();
		expect(sentToModel).not.toContain(thumbnailToken);
		expect(sentToModel).not.toContain(thumbnailBase64());
		expect(sentToModel).not.toContain(fileNameToken);
	});

	it("Option A on + cloud model + a local model that can see: the thumbnails go to the local model alone, and the cloud model gets the summary", async () => {
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockImplementation(
			async (id: string) => id === CLOUD_CHAT_MODEL,
		);
		mocks.modelIdCanSeeImages.mockImplementation(
			async (id: string) => id === LOCAL_SEEING_MODEL,
		);

		const { outcome, sentToModel } = await lookAs(CLOUD_CHAT_MODEL);

		// The bytes were read, by the local model and nobody else ...
		expect(mocks.describeImage).toHaveBeenCalledTimes(3);
		for (const [call] of mocks.describeImage.mock.calls) {
			expect(call.provider).toBe(localProvider);
			expect(call.image.base64).toBe(thumbnailBase64());
		}
		// ... what it said went to the summary, as the gate always does ...
		expect(mocks.distillConnectorPayload).toHaveBeenCalledWith(
			expect.objectContaining({
				rawText: expect.stringContaining(descriptionToken),
			}),
		);
		// ... and the cloud model was sent neither, nor the names.
		expect(outcome.modelPayload.message).toContain("Three beach photos.");
		expect(sentToModel).not.toContain(thumbnailToken);
		expect(sentToModel).not.toContain(thumbnailBase64());
		expect(sentToModel).not.toContain(descriptionToken);
		expect(sentToModel).not.toContain(fileNameToken);
	});

	it("Option A on + cloud model that can see itself: still no thumbnail", async () => {
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockImplementation(
			async (id: string) => id === CLOUD_CHAT_MODEL,
		);
		mocks.modelIdCanSeeImages.mockResolvedValue(true);

		const { sentToModel } = await lookAs(CLOUD_CHAT_MODEL);

		expect(sentToModel).not.toContain(thumbnailToken);
		expect(sentToModel).not.toContain(thumbnailBase64());
	});

	it("Option A on + cloud model + the summarising model is in the cloud too: nothing is downloaded or described", async () => {
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.modelIdCanSeeImages.mockResolvedValue(true);

		const { sentToModel } = await lookAs(CLOUD_CHAT_MODEL);

		expect(mocks.immichThumbnail).not.toHaveBeenCalled();
		expect(mocks.describeImage).not.toHaveBeenCalled();
		expect(sentToModel).not.toContain(thumbnailBase64());
	});

	it("Option A on + local model that can see: the thumbnails are queued, and stay on the box", async () => {
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(false);
		mocks.modelIdCanSeeImages.mockResolvedValue(true);

		const { outcome, sentToModel } = await lookAs("model1");

		expect(outcome.viewedCount).toBe(3);
		expect(sentToModel).toContain(thumbnailBase64());
		expect(mocks.describeImage).not.toHaveBeenCalled();
	});

	it("Option A off + cloud model that can see: the person chose the cloud, so the thumbnails are queued for it", async () => {
		mocks.hasLocalDistillEnabled.mockResolvedValue(false);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.modelIdCanSeeImages.mockResolvedValue(true);

		const { outcome, sentToModel } = await lookAs(CLOUD_CHAT_MODEL);

		expect(outcome.viewedCount).toBe(3);
		expect(sentToModel).toContain(thumbnailBase64());
	});

	// The tool decides for the model the turn started on (the tool pack fixes its
	// model id once), and the attempt that is sent the pictures can be a different
	// one: a failover to a cloud model that is ticked "Can see images". So the
	// pictures are followed to the attempt itself: the real photos tool fills the
	// queue for a person who keeps summarising local and a local model, and the
	// real model run hands them to the provider of the attempt it is on.
	describe("the attempt that is sent the pictures", () => {
		const CLOUD_BASE_URL = "https://api.cloud.example/v1";
		const BOX_BASE_URL = "http://192.168.1.96:30000/v1";

		function attemptProvider(baseUrl: string, canSee: boolean) {
			return {
				id: "attempt",
				name: "attempt",
				displayName: "Attempt",
				baseUrl,
				modelName: "attempt-model",
				apiKey: "key",
				...(canSee
					? {
							capabilities: createModelCapabilitySet({
								imageMessageParts: {
									state: "manual_override",
									supported: true,
									source: "manual_override",
								},
							}),
						}
					: {}),
			};
		}

		function completion(message: Record<string, unknown>, finish: string) {
			return new Response(
				JSON.stringify({
					id: "chatcmpl-1",
					object: "chat.completion",
					created: 0,
					model: "attempt-model",
					choices: [{ index: 0, message, finish_reason: finish }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}

		/**
		 * One plain run on `provider`: the model asks for the photos with a look,
		 * the real photos tool runs for a local model and a person who keeps
		 * summarising local, and the model answers. Returns the requests it made.
		 */
		async function runOn(provider: ReturnType<typeof attemptProvider>) {
			mocks.hasLocalDistillEnabled.mockResolvedValue(true);
			mocks.isCloudModel.mockResolvedValue(false);
			mocks.modelIdCanSeeImages.mockResolvedValue(true);
			const [
				{ runPhotosTool },
				{ createStepImageQueue },
				{ runPlainNormalChatModelRun },
			] = await Promise.all([
				import("$lib/server/services/normal-chat-tools/photos"),
				import("$lib/server/services/vision/step-images"),
				import("$lib/server/services/normal-chat-model"),
			]);
			const queue = createStepImageQueue();
			const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
			const fetchMock = vi.fn(
				async (_input: unknown, init?: { body?: unknown }) => {
					const body = JSON.parse(String(init?.body ?? "{}"));
					requests.push(body);
					return requests.length === 1
						? completion(
								{
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "call-look-1",
											type: "function",
											function: {
												name: "photos",
												arguments: JSON.stringify({ query: "x" }),
											},
										},
									],
								},
								"tool_calls",
							)
						: completion({ role: "assistant", content: "The second." }, "stop");
				},
			);

			await runPlainNormalChatModelRun({
				provider,
				messages: [
					{ role: "user", content: "Which of these is the sharpest?" },
				],
				tools: {
					photos: tool({
						description: "Find photos.",
						inputSchema: z.object({ query: z.string() }),
						execute: async () =>
							(
								await runPhotosTool(
									"user-1",
									{ action: "search", query: "x", look: true },
									"model1",
									undefined,
									{ queue },
								)
							).modelPayload,
					}),
				},
				stepImages: queue,
				fetch: fetchMock as unknown as typeof fetch,
				maxRetries: 0,
			});
			return requests;
		}

		function lastUserMessage(request: {
			messages: Array<Record<string, unknown>>;
		}) {
			return JSON.stringify(
				[...request.messages].reverse().find((m) => m.role === "user"),
			);
		}

		it("sends a cloud model that can see no thumbnail, whatever the tool decided for the model the turn started on", async () => {
			const requests = await runOn(attemptProvider(CLOUD_BASE_URL, true));

			expect(requests).toHaveLength(2);
			const wire = JSON.stringify(requests);
			expect(wire).not.toContain("image_url");
			expect(wire).not.toContain("base64,");
			expect(wire).not.toContain(thumbnailToken);
			expect(wire).not.toContain(thumbnailBase64());
			// The user message the step adds says that pictures were here and names
			// none of the photos. (The tool's own result text above it is gated for the
			// turn's first model, like every connector's: this is about the pictures.)
			const added = lastUserMessage(requests[1] as never);
			expect(added).not.toContain(fileNameToken);
			expect(added).toContain("cannot see images");
		});

		it("sends a cloud model that cannot see the same", async () => {
			const requests = await runOn(attemptProvider(CLOUD_BASE_URL, false));

			const wire = JSON.stringify(requests);
			expect(wire).not.toContain("image_url");
			expect(wire).not.toContain(thumbnailBase64());
			expect(lastUserMessage(requests[1] as never)).not.toContain(
				fileNameToken,
			);
		});

		it("sends the model on the person's own box the pictures, with the names: the control", async () => {
			const requests = await runOn(attemptProvider(BOX_BASE_URL, true));

			const added = lastUserMessage(requests[1] as never);
			expect(added).toContain("image_url");
			expect(added).toContain(thumbnailBase64());
			expect(added).toContain(fileNameToken);
		});
	});
});

describe("locality — media (Option A)", () => {
	beforeEach(resetSharedMocks);

	it("Option A on + cloud model: raw watch-history title is provably absent from JSON.stringify(modelPayload); candidates keep it", async () => {
		const token = distinctiveToken("media-title");
		mocks.resolveConnectionsForCapability.mockResolvedValue([
			makeConn({ provider: "plex", capabilities: ["media"] }),
		]);
		mocks.plexWatchHistory.mockResolvedValue([
			{
				title: token,
				type: "movie",
				viewedAt: "2026-06-01T09:55:00.000Z",
				library: "Movies",
			},
		]);
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.distillConnectorPayload.mockResolvedValue({
			distilled: "One movie watched recently.",
		});

		const { runMediaTool } = await import(
			"$lib/server/services/normal-chat-tools/media"
		);
		const outcome = await runMediaTool(
			"user-1",
			{ action: "watch_history" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(true);
		expect(JSON.stringify(outcome.modelPayload)).not.toContain(token);
		expect(JSON.stringify(outcome.candidates)).toContain(token);
	});
});

describe("locality — location (Option A)", () => {
	beforeEach(resetSharedMocks);

	it("Option A on + cloud model: raw place name (and lat/lon) is provably absent from JSON.stringify(modelPayload); candidates keep the coordinates", async () => {
		const token = distinctiveToken("place-name");
		mocks.resolveConnectionsForCapability.mockResolvedValue([
			makeConn({ provider: "owntracks", capabilities: ["location"] }),
		]);
		mocks.owntracksLastLocation.mockResolvedValue({
			lat: 47.497913,
			lon: 19.040236,
			at: "2026-07-01T12:00:00.000Z",
			place: token,
		});
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.distillConnectorPayload.mockResolvedValue({
			distilled: "Somewhere in the city center.",
		});

		const { runLocationTool } = await import(
			"$lib/server/services/normal-chat-tools/location"
		);
		const outcome = await runLocationTool(
			"user-1",
			{ action: "last" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(true);
		expect(JSON.stringify(outcome.modelPayload)).not.toContain(token);
		expect(JSON.stringify(outcome.candidates)).toContain("47.497913");
	});
});

describe("locality — contacts (Option A)", () => {
	beforeEach(resetSharedMocks);

	it("Option A on + cloud model: raw contact name/email is provably absent from JSON.stringify(modelPayload); candidates keep it", async () => {
		const nameToken = distinctiveToken("contact-name");
		const emailToken = `${distinctiveToken("contact-email").toLowerCase()}@example.com`;
		mocks.resolveConnectionsForCapability.mockResolvedValue([
			makeConn({ provider: "google", capabilities: ["contacts"] }),
		]);
		mocks.resolveContacts.mockResolvedValue([
			{
				name: nameToken,
				emails: [emailToken],
				phones: [],
				source: "google",
				account: "alice@example.com",
			},
		]);
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.distillConnectorPayload.mockResolvedValue({
			distilled: "One matching contact.",
		});

		const { runContactsTool } = await import(
			"$lib/server/services/normal-chat-tools/contacts"
		);
		const outcome = await runContactsTool(
			"user-1",
			{ action: "lookup", query: "x" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(true);
		const serialized = JSON.stringify(outcome.modelPayload);
		expect(serialized).not.toContain(nameToken);
		expect(serialized).not.toContain(emailToken);
		expect(JSON.stringify(outcome.candidates)).toContain(nameToken);
	});
});

// ---------------------------------------------------------------------------
// 8.1 REQUIRED test I1 — whole-outbound-context locality. Not the injected
// block in isolation (already covered by chat-turn/proactive-connector-
// context.test.ts's own locality describe) — the WHOLE assembled outbound
// context string handed to the model this turn.
// ---------------------------------------------------------------------------
describe("locality — 8.1 whole-outbound-context locality (I1, REQUIRED)", () => {
	const modelConfig = {
		baseUrl: "http://local-model/v1",
		apiKey: "local-key",
		modelName: "local-model",
		displayName: "Local Model",
		systemPrompt: "alfyai-nemotron",
		maxTokens: 4096,
		reasoningEffort: null,
		thinkingType: null,
	};

	beforeEach(() => {
		resetSharedMocks();
		mocks.googleListEvents.mockReset();
		mocks.imapListRecent.mockReset();
		mocks.isConversationIncognito.mockReset();
		mocks.isConversationIncognito.mockResolvedValue(false);
		mocks.buildConstructedContext.mockReset();
		mocks.getConfig.mockReset();
		mocks.getConfig.mockReturnValue({ contextDiagnosticsDebug: false });
		mocks.getSystemPrompt.mockReset();
		mocks.getSystemPrompt.mockReturnValue("Base system prompt");
		mocks.getLatestValidContextCompressionSnapshot.mockReset();
		mocks.getLatestValidContextCompressionSnapshot.mockResolvedValue(null);
		mocks.listContextCompressionSourceMessages.mockReset();
		mocks.listContextCompressionSourceMessages.mockResolvedValue([]);
		mocks.runContextCompression.mockReset();
	});

	it("with Option A on + cloud model + calendar/email active, neither the injected block NOR the whole assembled outbound context string carries a raw event title/location/email subject/sender — distilled only", async () => {
		const calendarToken = distinctiveToken("proactive-calendar");
		const locationToken = distinctiveToken("proactive-location");
		const emailToken = distinctiveToken("proactive-email-subject");
		const senderToken = distinctiveToken("proactive-email-sender");

		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) => {
				if (capability === "calendar") {
					return [makeConn({ id: "conn-cal", provider: "google" })];
				}
				if (capability === "email") {
					return [
						makeConn({
							id: "conn-imap",
							provider: "imap",
							capabilities: ["email"],
						}),
					];
				}
				return [];
			},
		);
		mocks.googleListEvents.mockResolvedValue([
			{
				id: "evt-1",
				summary: calendarToken,
				start: "2026-07-09T15:00:00.000Z",
				end: "2026-07-09T15:30:00.000Z",
				location: locationToken,
				htmlLink: "https://calendar.google.com/evt-1",
			},
		]);
		mocks.imapListRecent.mockResolvedValue([
			{
				uid: 1,
				from: senderToken,
				subject: emailToken,
				date: "2026-07-09T08:00:00.000Z",
				seen: false,
			},
		]);
		// Option A ON + cloud model -> distill every capability's raw text.
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.distillConnectorPayload.mockImplementation(
			async (params: { capability: string }) => ({
				distilled:
					params.capability === "calendar"
						? "One meeting this afternoon."
						: "One unread message.",
			}),
		);
		mocks.buildConstructedContext.mockResolvedValue({
			inputValue: "Do I have any meetings today, and any unread email?",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			_reuseData: undefined,
		});

		const { prepareOutboundChatContext } = await import(
			"$lib/server/services/normal-chat-context"
		);
		const prepared = await prepareOutboundChatContext({
			message: "Do I have any meetings today, and any unread email?",
			sessionId: "conv-1",
			modelConfig,
			user: { id: "user-1" },
			modelId: "model1",
			activeConnectionCapabilities: new Set(["calendar", "email"]),
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
			logLabel: "provider request",
		});

		// The injected block was really built (sanity: the distilled summaries
		// appear).
		expect(prepared.inputValue).toContain("One meeting this afternoon.");
		expect(prepared.inputValue).toContain("One unread message.");

		// The single most important assertion: raw connector tokens are absent
		// from the WHOLE assembled outbound context string, not just the
		// isolated block.
		expect(prepared.inputValue).not.toContain(calendarToken);
		expect(prepared.inputValue).not.toContain(locationToken);
		expect(prepared.inputValue).not.toContain(emailToken);
		expect(prepared.inputValue).not.toContain(senderToken);
		// ...and the rebuilt system prompt (also model-bound) too.
		expect(prepared.systemPrompt).not.toContain(calendarToken);
		expect(prepared.systemPrompt).not.toContain(emailToken);
	});

	it("distill-unavailable: nothing is injected (not the raw text) into the whole outbound context", async () => {
		const calendarToken = distinctiveToken("proactive-calendar-unavailable");
		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) =>
				capability === "calendar" ? [makeConn({ id: "conn-cal" })] : [],
		);
		mocks.googleListEvents.mockResolvedValue([
			{
				id: "evt-1",
				summary: calendarToken,
				start: "2026-07-09T15:00:00.000Z",
				end: "2026-07-09T15:30:00.000Z",
				htmlLink: "https://calendar.google.com/evt-1",
			},
		]);
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(true);
		mocks.distillConnectorPayload.mockResolvedValue({ unavailable: true });
		mocks.buildConstructedContext.mockResolvedValue({
			inputValue: "Do I have any meetings today?",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			_reuseData: undefined,
		});

		const { prepareOutboundChatContext } = await import(
			"$lib/server/services/normal-chat-context"
		);
		const prepared = await prepareOutboundChatContext({
			message: "Do I have any meetings today?",
			sessionId: "conv-1",
			modelConfig,
			user: { id: "user-1" },
			modelId: "model1",
			activeConnectionCapabilities: new Set(["calendar"]),
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
			logLabel: "provider request",
		});

		expect(prepared.inputValue).not.toContain(calendarToken);
		expect(prepared.inputValue).not.toContain("## Your calendar & mail (live)");
	});
});

// ---------------------------------------------------------------------------
// 8.1 REQUIRED test I2 — no-memory-fact / memory boundary. A turn that
// injects proactive connector context (present in `upstreamMessage`, the
// assembled outbound prompt — see normal-chat-context.ts, whose
// `runProactiveConnectorContextStage` splices the block into `inputValue`,
// which becomes `upstreamMessage` for the model call) creates NO memory fact
// and never threads that content into the memory-judge/summary pipeline.
// runPostTurnTasks (chat-turn/finalize-steps.ts) is the single post-turn entry
// point that schedules memory intake; PINS (by code inspection AND this
// runtime proof) that it only ever reads `params.userMessage` /
// `params.assistantResponse` / `params.assistantMirrorContent` — NEVER
// `params.upstreamMessage` — for detectExplicitMemoryRequest,
// scheduleConversationJudge, markMemoryDirty, runMemoryJudgeOnSegment, or
// refreshConversationSummary.
// ---------------------------------------------------------------------------
describe("locality — 8.1 no-memory-fact / memory boundary (I2, REQUIRED)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isMemoryActiveForConversation.mockResolvedValue(true);
		mocks.isConversationIncognito.mockResolvedValue(false);
		mocks.detectExplicitMemoryRequest.mockReturnValue(false);
		mocks.countUnjudgedMessages.mockResolvedValue(0);
		mocks.markMemoryDirty.mockResolvedValue({
			id: "dirty-1",
			reason: "deferred_intake",
			count: 1,
		});
		mocks.runMemoryJudgeOnSegment.mockResolvedValue({ status: "ran" });
		mocks.refreshConversationSummary.mockResolvedValue(undefined);
	});

	it("a proactive-connector-context token present in upstreamMessage never reaches any memory-intake call's arguments", async () => {
		const proactiveToken = distinctiveToken("proactive-context-never-memory");
		// Simulates the SAME turn's assembled outbound prompt (what
		// stream-completion.ts binds to `upstreamMessage`) carrying the
		// proactive connector block — the raw connector-derived text this
		// guarantee must keep out of memory.
		const upstreamMessageWithProactiveBlock = [
			"## Your calendar & mail (live)",
			`Calendar (next 48h):\n- 2026-07-09 15:00-15:30 - ${proactiveToken}`,
			"## Current User Message",
			"Do I have any meetings today?",
		].join("\n\n");

		const { runPostTurnTasks } = await import(
			"$lib/server/services/chat-turn/finalize-steps"
		);
		await runPostTurnTasks({
			logPrefix: "[SEND]",
			userId: "user-1",
			conversationId: "conv-1",
			upstreamMessage: upstreamMessageWithProactiveBlock,
			userMessage: "Do I have any meetings today?",
			assistantResponse: "You have one meeting this afternoon.",
			assistantMirrorContent: "You have one meeting this afternoon.",
			maintenanceReason: "chat_send",
		});

		const allMemoryCalls = [
			...mocks.detectExplicitMemoryRequest.mock.calls,
			...mocks.scheduleConversationJudge.mock.calls,
			...mocks.markMemoryDirty.mock.calls,
			...mocks.runMemoryJudgeOnSegment.mock.calls,
			...mocks.countUnjudgedMessages.mock.calls,
			...mocks.refreshConversationSummary.mock.calls,
		];
		expect(allMemoryCalls.length).toBeGreaterThan(0); // sanity: intake ran
		for (const call of allMemoryCalls) {
			expect(JSON.stringify(call)).not.toContain(proactiveToken);
		}
	});
});
