// "From this chat" (Feature 2 · Canvas): what a board's own conversation has
// that can be put on the board — its files, Apps, route maps, charts and diagrams —
// against a real in-memory database. The scope is the point: the listing is a
// second way to read a conversation's work, so it must reach exactly what the
// artifact routes reach and nothing beside it.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { boardJson, emptyCanvasBody } from "$lib/shared/artifacts/canvas-body";
import {
	attachedFileId,
	CHAT_BLOCKS_PER_KIND,
	CHAT_BLOCKS_SCAN_MESSAGES,
} from "$lib/shared/artifacts/chat-blocks";
import {
	NOW,
	seedConversation,
	seedProducedFile,
	seedUser,
} from "./artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { createArtifact, listCanvasChatBlocks } = await import("./index");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-a";
const OTHER_CONVERSATION = "conv-b";
const INCOGNITO = "conv-incognito";
const STRANGER_CONVERSATION = "conv-stranger";

/** A route as the map_route tool persists it. */
const MAP = {
	bounds: { minLat: 51.706, minLng: -8.53, maxLat: 51.897, maxLng: -8.47 },
	markers: [
		{ lat: 51.897, lng: -8.47, label: "Cork", kind: "origin" },
		{ lat: 51.706, lng: -8.53, label: "Kinsale", kind: "destination" },
	],
	polyline: [
		[51.897, -8.47],
		[51.78, -8.5],
		[51.706, -8.53],
	],
	distanceM: 27_000,
	durationS: 2040,
	mode: "drive",
	originLabel: "Cork",
	destinationLabel: "Kinsale",
	attribution: "© OpenStreetMap contributors",
};

const CHART = {
	type: "bar",
	data: { labels: ["A", "B"], datasets: [{ data: [3, 5] }] },
};

let sequence = 0;
const minute = (n: number) => new Date(NOW.getTime() + n * 60_000);

function seedMessage(params: {
	conversationId?: string;
	role?: "user" | "assistant";
	content?: string;
	toolCalls?: unknown[];
	at?: number;
	id?: string;
}): string {
	sequence += 1;
	const id = params.id ?? `message-${sequence}`;
	memory.db
		.insert(schema.messages)
		.values({
			id,
			conversationId: params.conversationId ?? CONVERSATION,
			messageSequence: sequence,
			role: params.role ?? "assistant",
			content: params.content ?? "Here you go.",
			toolCalls: params.toolCalls ? JSON.stringify(params.toolCalls) : null,
			createdAt: minute(params.at ?? sequence),
		})
		.run();
	return id;
}

const fence = (config: unknown) =>
	`Here is the chart.\n\n\`\`\`chart\n${JSON.stringify(config)}\n\`\`\`\n`;

const mermaid = (source: string) =>
	`Here is the diagram.\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`;

function mapCall(map: unknown = MAP, extra: Record<string, unknown> = {}) {
	sequence += 1;
	return {
		type: "tool_call",
		callId: `call-${sequence}`,
		name: "map_route",
		input: { action: "route", from: "Cork", to: "Kinsale" },
		status: "done",
		map,
		...extra,
	};
}

/** A photo the photos tool found, as the tool persists it on the call: the chat's own strip reads exactly this. */
function photoCandidate(assetId: string, title = `${assetId}.jpg`) {
	return {
		id: `photos:${assetId}`,
		title,
		url: "",
		snippet: title,
		sourceType: "tool",
		metadata: { thumbnailPath: `/api/assets/${assetId}/thumbnail` },
	};
}

function photosCall(
	assetIds: string[],
	extra: Record<string, unknown> = {},
	input: Record<string, unknown> = { action: "search", query: "beach" },
) {
	sequence += 1;
	return {
		type: "tool_call",
		callId: `call-${sequence}`,
		name: "photos",
		input,
		status: "done",
		candidates: assetIds.map((id) => photoCandidate(id)) as unknown[],
		metadata: { ok: true, action: input.action, resultCount: assetIds.length },
		...extra,
	};
}

/** A source the web search returned, as the tool persists it as a candidate. */
function webCandidate(index: number, extra: Record<string, unknown> = {}) {
	return {
		id: `src-${index}`,
		title: `Result ${index}`,
		url: `https://example.com/page-${index}`,
		snippet: `About result ${index}.`,
		sourceType: "web",
		material: true,
		metadata: {
			provider: "parallel",
			authorityClass: "primary",
			authorityScore: 0.9 - index / 100,
			providerRank: index,
			publishedAt: "2026-09-01",
		},
		...extra,
	};
}

function researchCall(
	count: number,
	extra: Record<string, unknown> = {},
	query = "cork weather this weekend",
) {
	sequence += 1;
	return {
		type: "tool_call",
		callId: `call-${sequence}`,
		name: "research_web",
		input: { query },
		status: "done",
		sourceType: "web",
		candidates: Array.from({ length: count }, (_, index) =>
			webCandidate(index + 1),
		) as unknown[],
		metadata: { ok: true, evidenceReady: true, sourceCount: count },
		...extra,
	};
}

function seedChatFile(params: {
	id: string;
	filename: string;
	at: number;
	conversationId?: string;
	userId?: string;
	mimeType?: string | null;
	sizeBytes?: number;
}): void {
	const messageId = seedMessage({
		conversationId: params.conversationId ?? CONVERSATION,
		at: params.at,
	});
	memory.db
		.insert(schema.chatGeneratedFiles)
		.values({
			id: params.id,
			conversationId: params.conversationId ?? CONVERSATION,
			assistantMessageId: messageId,
			userId: params.userId ?? OWNER,
			filename: params.filename,
			mimeType:
				params.mimeType === undefined ? "application/pdf" : params.mimeType,
			sizeBytes: params.sizeBytes ?? 2048,
			storagePath: `${params.conversationId ?? CONVERSATION}/${params.filename}`,
			createdAt: minute(params.at),
		})
		.run();
}

/** An uploaded file the reader attached to a message of the conversation. */
function seedAttachment(params: {
	artifactId: string;
	name: string;
	at: number;
	conversationId?: string;
	type?: string;
	mimeType?: string | null;
	sizeBytes?: number | null;
}): void {
	const conversationId = params.conversationId ?? CONVERSATION;
	const messageId = seedMessage({
		conversationId,
		role: "user",
		content: "See the file.",
		at: params.at,
	});
	memory.db
		.insert(schema.artifacts)
		.values({
			id: params.artifactId,
			userId: OWNER,
			conversationId,
			type: params.type ?? "source_document",
			retrievalClass: "durable",
			name: params.name,
			mimeType:
				params.mimeType === undefined ? "application/pdf" : params.mimeType,
			sizeBytes: params.sizeBytes === undefined ? 4096 : params.sizeBytes,
			createdAt: minute(params.at),
			updatedAt: minute(params.at),
		})
		.run();
	memory.db
		.insert(schema.artifactLinks)
		.values({
			id: randomUUID(),
			userId: OWNER,
			artifactId: params.artifactId,
			conversationId,
			messageId,
			linkType: "attached_to_conversation",
			createdAt: minute(params.at),
		})
		.run();
}

async function makeArtifact(
	kind: "app" | "document" | "canvas",
	title: string,
	options: {
		conversationId?: string | null;
		userId?: string;
		body?: string;
	} = {},
) {
	const created = await createArtifact({
		userId: options.userId ?? OWNER,
		conversationId:
			options.conversationId === undefined
				? CONVERSATION
				: options.conversationId,
		kind,
		title,
		body:
			options.body ??
			(kind === "canvas"
				? boardJson(emptyCanvasBody())
				: kind === "app"
					? "<!doctype html><title>App</title><p>hi</p>"
					: "# Notes"),
		author: "alfy",
		versionSummary: "Made",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact;
}

async function listFor(board: { id: string }, conversationId?: string | null) {
	return listCanvasChatBlocks({
		userId: OWNER,
		artifactId: board.id,
		conversationId,
	});
}

const EMPTY = {
	files: [],
	apps: [],
	maps: [],
	charts: [],
	diagrams: [],
	photos: [],
	searches: [],
};

beforeEach(() => {
	sequence = 0;
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, { id: OTHER_CONVERSATION, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
	seedConversation(memory, { id: STRANGER_CONVERSATION, userId: STRANGER });
});

afterEach(() => {
	memory.close();
});

describe("who may ask, and about which chat", () => {
	it("answers nothing for another user's board, an id that does not exist and something that is not a board, and all three alike", async () => {
		const strangers = await makeArtifact("canvas", "Theirs", {
			conversationId: STRANGER_CONVERSATION,
			userId: STRANGER,
		});
		const document = await makeArtifact("document", "Notes");

		const foreign = await listFor(strangers);
		const missing = await listFor({ id: "no-such-board" });
		const notABoard = await listFor(document);

		expect(foreign).toBeNull();
		expect(missing).toBeNull();
		expect(notABoard).toBeNull();
	});

	it("never lists the chat of a board it cannot read, even when the chat is named", async () => {
		const board = await makeArtifact("canvas", "Theirs", {
			conversationId: STRANGER_CONVERSATION,
			userId: STRANGER,
		});
		expect(await listFor(board, STRANGER_CONVERSATION)).toBeNull();
	});

	it("hides an incognito chat's board unless the read names that chat, and shows it to no other chat", async () => {
		const board = await makeArtifact("canvas", "Private", {
			conversationId: INCOGNITO,
		});
		seedMessage({
			conversationId: INCOGNITO,
			content: fence(CHART),
			toolCalls: [photosCall(["private-1"]), researchCall(2)],
		});

		expect(await listFor(board)).toBeNull();
		expect(await listFor(board, OTHER_CONVERSATION)).toBeNull();
		const named = await listFor(board, INCOGNITO);
		expect(named?.charts).toHaveLength(1);
		expect(named?.photos).toHaveLength(1);
		expect(named?.searches).toHaveLength(1);
	});

	it("answers nothing for a board whose chat link is gone: the family never reads such a row, and neither does this", async () => {
		const board = await makeArtifact("canvas", "Orphaned");
		memory.sqlite
			.prepare("UPDATE artifacts SET conversation_id = NULL WHERE id = ?")
			.run(board.id);
		expect(await listFor(board)).toBeNull();
	});

	it("lists only THIS chat's work: another chat of the same user never appears", async () => {
		const board = await makeArtifact("canvas", "Board");
		await makeArtifact("app", "Their app", {
			conversationId: OTHER_CONVERSATION,
		});
		seedChatFile({
			id: "other-file",
			filename: "other.pdf",
			at: 2,
			conversationId: OTHER_CONVERSATION,
		});
		seedMessage({
			conversationId: OTHER_CONVERSATION,
			content: fence(CHART),
			toolCalls: [mapCall(), photosCall(["theirs-1"]), researchCall(2)],
		});

		expect(await listFor(board)).toEqual(EMPTY);
	});
});

describe("files", () => {
	it("lists a produced file by the id its download and preview routes take, with the label the chat shows", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedChatFile({
			id: "chat-file-1",
			filename: "Vienna trip summary.pdf",
			at: 5,
			sizeBytes: 2048,
		});

		const listing = await listFor(board);

		expect(listing?.files).toHaveLength(1);
		expect(listing?.files[0]).toMatchObject({
			origin: "produced",
			data: {
				kind: "file",
				fileId: "chat-file-1",
				name: "Vienna trip summary.pdf",
				mime: "application/pdf",
				bytes: 2048,
				label: "PDF",
			},
		});
		expect(typeof listing?.files[0].key).toBe("string");
		expect(listing?.files[0].at).toBe(minute(5).getTime());
	});

	it("lists a file the reader attached under the panel's own item id for it, and only uploaded files", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedAttachment({
			artifactId: "att-1",
			name: "budget.xlsx",
			at: 3,
			mimeType: null,
			sizeBytes: null,
		});
		seedAttachment({
			artifactId: "att-2",
			name: "derived.md",
			at: 4,
			type: "normalized_document",
		});

		const listing = await listFor(board);

		expect(listing?.files.map((file) => file.data.fileId)).toEqual([
			attachedFileId("att-1"),
		]);
		expect(listing?.files[0]).toMatchObject({
			origin: "attached",
			data: { name: "budget.xlsx", mime: "", bytes: 0, label: "XLSX" },
		});
	});

	it("puts the newest first, produced and attached together, and stops at the bound", async () => {
		const board = await makeArtifact("canvas", "Board");
		for (let index = 0; index < CHAT_BLOCKS_PER_KIND; index += 1) {
			seedChatFile({
				id: `produced-${index}`,
				filename: `report-${index}.pdf`,
				at: 10 + index,
			});
		}
		seedAttachment({ artifactId: "att-new", name: "newest.docx", at: 500 });
		seedAttachment({ artifactId: "att-old", name: "oldest.docx", at: 1 });

		const listing = await listFor(board);

		expect(listing?.files).toHaveLength(CHAT_BLOCKS_PER_KIND);
		expect(listing?.files[0].data.name).toBe("newest.docx");
		const times = listing?.files.map((file) => file.at) ?? [];
		expect(times).toEqual([...times].sort((a, b) => b - a));
		expect(
			listing?.files.some((file) => file.data.name === "oldest.docx"),
		).toBe(false);
	});

	it("carries the version a produced file's family is on, so two versions of one report can be told apart, and none for a file with no family", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedProducedFile(memory, {
			userId: OWNER,
			conversationId: CONVERSATION,
			artifactId: "produced-artifact",
			filename: "report.pdf",
		});
		seedChatFile({ id: "loose-file", filename: "loose.pdf", at: 50 });

		const listing = await listFor(board);

		const byName = new Map(
			listing?.files.map((file) => [file.data.name, file.version]),
		);
		expect(byName.get("report.pdf")).toBe(1);
		expect(byName.get("loose.pdf")).toBeNull();
	});
});

describe("Apps", () => {
	it("lists this chat's Apps by their own id and title, newest change first, and no other kind", async () => {
		const board = await makeArtifact("canvas", "Board");
		const older = await makeArtifact("app", "Tip calculator");
		const newer = await makeArtifact("app", "Habit tracker");
		await makeArtifact("document", "Notes");
		memory.sqlite
			.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?")
			.run(Math.floor(minute(1).getTime() / 1000), older.id);
		memory.sqlite
			.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?")
			.run(Math.floor(minute(9).getTime() / 1000), newer.id);

		const listing = await listFor(board);

		expect(listing?.apps.map((app) => app.data)).toEqual([
			{ kind: "app", artifactId: newer.id, title: "Habit tracker" },
			{ kind: "app", artifactId: older.id, title: "Tip calculator" },
		]);
		expect(listing?.apps[0].versionNumber).toBeGreaterThanOrEqual(1);
	});

	it("stops at the bound", async () => {
		const board = await makeArtifact("canvas", "Board");
		for (let index = 0; index < CHAT_BLOCKS_PER_KIND + 3; index += 1) {
			await makeArtifact("app", `App ${index}`);
		}
		const listing = await listFor(board);
		expect(listing?.apps).toHaveLength(CHAT_BLOCKS_PER_KIND);
	});
});

describe("maps", () => {
	it("lists the routes the chat's map_route calls returned, newest first, with the payload the chat's own card draws", async () => {
		const board = await makeArtifact("canvas", "Board");
		const older = { ...MAP, originLabel: "Vienna", destinationLabel: "Graz" };
		seedMessage({ at: 1, toolCalls: [mapCall(older)] });
		seedMessage({
			at: 2,
			toolCalls: [mapCall(MAP, { input: { action: "transit" } })],
		});

		const listing = await listFor(board);

		expect(listing?.maps).toHaveLength(2);
		expect(listing?.maps[0].map).toMatchObject({
			originLabel: "Cork",
			destinationLabel: "Kinsale",
			distanceM: 27_000,
		});
		expect(listing?.maps[0].action).toBe("transit");
		expect(listing?.maps[1].map.originLabel).toBe("Vienna");
		expect(listing?.maps[1].action).toBe("route");
		expect(listing?.maps[0].at).toBeGreaterThan(listing?.maps[1].at ?? 0);
	});

	it("takes only finished calls that carry a map, from the map tool alone", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			toolCalls: [
				mapCall(MAP, { status: "failed" }),
				mapCall(MAP, { status: "running" }),
				mapCall(null),
				{ ...mapCall(MAP), map: undefined },
				{ ...mapCall(MAP), name: "research_web" },
				{ type: "text", content: "thinking" },
			],
		});

		expect((await listFor(board))?.maps).toEqual([]);
	});

	it("leaves out a map the board's own schema would drop on save, instead of offering a block that vanishes", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			toolCalls: [
				mapCall({ bounds: { minLat: "north" }, attribution: 3 }),
				mapCall(MAP),
			],
		});

		const listing = await listFor(board);
		expect(listing?.maps).toHaveLength(1);
		expect(listing?.maps[0].map.originLabel).toBe("Cork");
	});

	it("stops at the bound, keeping the newest", async () => {
		const board = await makeArtifact("canvas", "Board");
		for (let index = 0; index < CHAT_BLOCKS_PER_KIND + 4; index += 1) {
			seedMessage({
				at: index + 1,
				toolCalls: [mapCall({ ...MAP, originLabel: `Stop ${index}` })],
			});
		}
		const listing = await listFor(board);
		expect(listing?.maps).toHaveLength(CHAT_BLOCKS_PER_KIND);
		expect(listing?.maps[0].map.originLabel).toBe(
			`Stop ${CHAT_BLOCKS_PER_KIND + 3}`,
		);
	});
});

describe("charts", () => {
	it("lists the charts the replies drew, as the chat draws them, newest first", async () => {
		const board = await makeArtifact("canvas", "Board");
		const first = {
			...CHART,
			options: { plugins: { title: { text: "Sales" } } },
		};
		const second = {
			type: "line",
			data: { labels: ["x"], datasets: [{ data: [1] }] },
		};
		seedMessage({ at: 1, content: fence(first) });
		seedMessage({ at: 2, content: fence(second) });

		const listing = await listFor(board);

		expect(listing?.charts).toHaveLength(2);
		expect(JSON.parse(listing?.charts[0].data.code ?? "{}")).toEqual(second);
		expect(listing?.charts[0]).toMatchObject({
			title: null,
			chartType: "line",
		});
		expect(listing?.charts[1]).toMatchObject({
			title: "Sales",
			chartType: "bar",
		});
		expect(listing?.charts[0].data.kind).toBe("chart");
		// A chart's own title heads its block, as it heads the chart; an untitled one has none.
		expect(listing?.charts[1].data.label).toBe("Sales");
		expect(listing?.charts[0].data.label).toBeUndefined();
	});

	it("finds the chart a bar-column table stands for, because the chat draws it", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			content: [
				"| Fruit | Sales | Scale |",
				"| --- | --- | --- |",
				"| Apples | 30 | ██████ |",
				"| Pears | 20 | ████ |",
				"| Plums | 10 | ██ |",
			].join("\n"),
		});

		const listing = await listFor(board);
		expect(listing?.charts).toHaveLength(1);
		expect(JSON.parse(listing?.charts[0].data.code ?? "{}").type).toBeTruthy();
	});

	it("reads assistant replies only: a chart fence the reader typed is not a chart the chat drew", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ role: "user", content: fence(CHART) });
		expect((await listFor(board))?.charts).toEqual([]);
	});

	it("shows one chart once, however many replies repeated it", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ at: 1, content: fence(CHART) });
		seedMessage({ at: 2, content: fence(CHART) });
		const listing = await listFor(board);
		expect(listing?.charts).toHaveLength(1);
		expect(listing?.charts[0].at).toBe(minute(2).getTime());
	});

	it("leaves out an unfinished fence and a chart too big for a block", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ content: '```chart\n{"type":"bar"' });
		seedMessage({
			content: fence({ ...CHART, pad: "x".repeat(101_000) }),
		});
		expect((await listFor(board))?.charts).toEqual([]);
	});

	it("stops at the bound, keeping the newest", async () => {
		const board = await makeArtifact("canvas", "Board");
		for (let index = 0; index < CHAT_BLOCKS_PER_KIND + 5; index += 1) {
			seedMessage({
				at: index + 1,
				content: fence({
					...CHART,
					options: { plugins: { title: { text: `Chart ${index}` } } },
				}),
			});
		}
		const listing = await listFor(board);
		expect(listing?.charts).toHaveLength(CHAT_BLOCKS_PER_KIND);
		expect(listing?.charts[0].title).toBe(`Chart ${CHAT_BLOCKS_PER_KIND + 4}`);
	});

	it("looks back over the newest replies only", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ at: 1, content: fence(CHART) });
		for (let index = 0; index < CHAT_BLOCKS_SCAN_MESSAGES; index += 1) {
			seedMessage({ at: index + 2, content: "Plain words." });
		}
		expect((await listFor(board))?.charts).toEqual([]);
	});
});

describe("diagrams", () => {
	const FLOW = "flowchart TD\n  A[Start] --> B{Valid?}\n  B -- No --> A";
	const SEQUENCE = "sequenceDiagram\n  User->>Shop: Checkout";

	it("lists the Mermaid diagrams the replies drew, as the chat draws them, newest first, each with what kind it is", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ at: 1, content: mermaid(FLOW) });
		seedMessage({ at: 2, content: mermaid(SEQUENCE) });

		const listing = await listFor(board);

		expect(listing?.diagrams).toHaveLength(2);
		expect(listing?.diagrams[0]).toMatchObject({
			title: null,
			diagramType: "sequenceDiagram",
			data: { kind: "mermaid", code: SEQUENCE },
		});
		expect(listing?.diagrams[1]).toMatchObject({
			diagramType: "flowchart",
			data: { kind: "mermaid", code: FLOW },
		});
		// A diagram with no title of its own has no label; the block is then named by its kind.
		expect(listing?.diagrams[0].data.label).toBeUndefined();
	});

	it("reads a diagram's own title the way Mermaid takes one, and heads its block with it", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			at: 1,
			content: mermaid('pie title Pets adopted\n  "Dogs" : 386'),
		});
		seedMessage({
			at: 2,
			content: mermaid(
				"gantt\n  title Release plan\n  dateFormat YYYY-MM-DD\n  A :a1, 2026-01-01, 3d",
			),
		});
		seedMessage({
			at: 3,
			content: mermaid(
				"---\ntitle: Checkout flow\n---\nflowchart LR\n  A --> B",
			),
		});
		seedMessage({
			at: 4,
			content: mermaid(
				"%% a note\n%%{init: {}}%%\nstateDiagram-v2\n  [*] --> A",
			),
		});

		const listing = await listFor(board);

		expect(
			listing?.diagrams.map((item) => [item.diagramType, item.title]),
		).toEqual([
			["stateDiagram-v2", null],
			["flowchart", "Checkout flow"],
			["gantt", "Release plan"],
			["pie", "Pets adopted"],
		]);
		expect(listing?.diagrams[1].data.label).toBe("Checkout flow");
		// The source is kept whole, frontmatter and all: what the chat drew.
		expect(listing?.diagrams[1].data.code).toContain("title: Checkout flow");
	});

	it("keeps charts and diagrams apart when one reply drew both", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			content: `${fence(CHART)}\n${mermaid(FLOW)}`,
		});
		const listing = await listFor(board);
		expect(listing?.charts).toHaveLength(1);
		expect(listing?.diagrams).toHaveLength(1);
		expect(listing?.charts[0].data.kind).toBe("chart");
		expect(listing?.diagrams[0].data.kind).toBe("mermaid");
	});

	it("reads assistant replies only: a diagram the reader typed is not a diagram the chat drew", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ role: "user", content: mermaid(FLOW) });
		expect((await listFor(board))?.diagrams).toEqual([]);
	});

	it("shows one diagram once, however many replies repeated it", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ at: 1, content: mermaid(FLOW) });
		seedMessage({ at: 2, content: mermaid(FLOW) });
		const listing = await listFor(board);
		expect(listing?.diagrams).toHaveLength(1);
		expect(listing?.diagrams[0].at).toBe(minute(2).getTime());
	});

	it("leaves out an unfinished fence and a source too big for a block", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ content: "```mermaid\nflowchart TD\n  A --> B" });
		seedMessage({ content: mermaid(`flowchart TD\n%% ${"x".repeat(51_000)}`) });
		expect((await listFor(board))?.diagrams).toEqual([]);
	});

	it("stops at the bound, keeping the newest", async () => {
		const board = await makeArtifact("canvas", "Board");
		for (let index = 0; index < CHAT_BLOCKS_PER_KIND + 5; index += 1) {
			seedMessage({
				at: index + 1,
				content: mermaid(`pie title Diagram ${index}\n  "A" : 1`),
			});
		}
		const listing = await listFor(board);
		expect(listing?.diagrams).toHaveLength(CHAT_BLOCKS_PER_KIND);
		expect(listing?.diagrams[0].title).toBe(
			`Diagram ${CHAT_BLOCKS_PER_KIND + 4}`,
		);
	});

	it("looks back over the newest replies only", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ at: 1, content: mermaid(FLOW) });
		for (let index = 0; index < CHAT_BLOCKS_SCAN_MESSAGES; index += 1) {
			seedMessage({ at: index + 2, content: "Plain words." });
		}
		expect((await listFor(board))?.diagrams).toEqual([]);
	});

	it("keeps looking for diagrams after the charts have filled their share", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ at: 1, content: mermaid(FLOW) });
		for (let index = 0; index < CHAT_BLOCKS_PER_KIND + 2; index += 1) {
			seedMessage({
				at: index + 2,
				content: fence({
					...CHART,
					options: { plugins: { title: { text: `Chart ${index}` } } },
				}),
			});
		}
		const listing = await listFor(board);
		expect(listing?.charts).toHaveLength(CHAT_BLOCKS_PER_KIND);
		expect(listing?.diagrams).toHaveLength(1);
	});
});

describe("photos", () => {
	it("lists the photos a search found as one block, each as the app's own thumbnail address the chat's strip shows", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			at: 4,
			toolCalls: [photosCall(["asset-1", "asset-2", "asset-3"])],
		});

		const listing = await listFor(board);

		expect(listing?.photos).toHaveLength(1);
		expect(listing?.photos[0]).toMatchObject({
			query: "beach",
			at: minute(4).getTime(),
			data: {
				kind: "photo",
				items: [
					{
						id: "asset-1",
						imageUrl: "/api/connections/immich/thumbnail/asset-1",
					},
					{
						id: "asset-2",
						imageUrl: "/api/connections/immich/thumbnail/asset-2",
					},
					{
						id: "asset-3",
						imageUrl: "/api/connections/immich/thumbnail/asset-3",
					},
				],
			},
		});
		expect(typeof listing?.photos[0].key).toBe("string");
	});

	it("carries no file name and no description into the board: the chat kept them for the reader's own screen, and a board can be read to a model", async () => {
		const board = await makeArtifact("canvas", "Board");
		const call = photosCall(["asset-1"]);
		call.candidates = [
			photoCandidate("asset-1", "hospital-visit-2024-oncology.jpg"),
		];
		seedMessage({ toolCalls: [call] });

		const listing = await listFor(board);

		const text = JSON.stringify(listing?.photos);
		expect(text).not.toContain("hospital");
		expect(text).not.toContain("oncology");
		for (const item of listing?.photos[0].data.items ?? []) {
			expect(item).not.toHaveProperty("alt");
		}
	});

	it("takes only finished searches that found photos, from the photos tool alone", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			toolCalls: [
				photosCall(["a"], { status: "failed" }),
				photosCall(["b"], { status: "running" }),
				photosCall(["c"], { metadata: { ok: false } }),
				photosCall([], {}, { action: "list_albums" }),
				photosCall(["d"], { name: "research_web" }),
				{ type: "text", content: "thinking" },
			],
		});

		expect((await listFor(board))?.photos).toEqual([]);
	});

	it("leaves out a result that is not an asset thumbnail of the photo library, so no other address can ride in on a candidate", async () => {
		const board = await makeArtifact("canvas", "Board");
		const call = photosCall(["good-1"]);
		const withPath = (id: string, thumbnailPath: unknown) => ({
			...photoCandidate(id),
			metadata: { thumbnailPath },
		});
		call.candidates.push(
			withPath("evil-1", "https://evil.example/p.png"),
			withPath("evil-2", "/api/assets/../../auth/logout/thumbnail"),
			withPath("evil-3", "/api/assets/a%2fb/thumbnail"),
			withPath("evil-4", "/api/assets/a\\evil.example/thumbnail"),
			withPath("evil-5", "//evil.example/api/assets/x/thumbnail"),
			withPath("evil-6", 42),
			withPath("evil-7", "/api/assets/x/original"),
		);
		seedMessage({ toolCalls: [call] });

		const listing = await listFor(board);

		expect(listing?.photos[0].data.items.map((item) => item.id)).toEqual([
			"good-1",
		]);
		expect(JSON.stringify(listing?.photos)).not.toContain("evil");
	});

	it("lists one search's photo once however many times it came back, and the same photo again in another search", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			at: 1,
			toolCalls: [photosCall(["a", "b", "a", "c", "b"])],
		});
		seedMessage({
			at: 2,
			toolCalls: [photosCall(["a"], {}, { action: "search", query: "again" })],
		});

		const listing = await listFor(board);

		expect(listing?.photos).toHaveLength(2);
		expect(listing?.photos[0].data.items.map((item) => item.id)).toEqual(["a"]);
		expect(listing?.photos[1].data.items.map((item) => item.id)).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("names what was looked for in the model's own words: the query, else the person, else the place", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			at: 1,
			toolCalls: [
				photosCall(["a"], {}, { action: "search", query: "  a dog in snow " }),
				photosCall(
					["b"],
					{},
					{ action: "search_by_date", personName: "Anna", city: "Graz" },
				),
				photosCall(
					["c"],
					{},
					{ action: "search_by_date", city: "Graz", country: "AT" },
				),
				photosCall(["d"], {}, { action: "album", albumId: "album-7" }),
			],
		});

		const listing = await listFor(board);

		const byFirst = new Map(
			listing?.photos.map((row) => [row.data.items[0].id, row.query]),
		);
		expect(byFirst.get("a")).toBe("a dog in snow");
		expect(byFirst.get("b")).toBe("Anna");
		expect(byFirst.get("c")).toBe("Graz");
		expect(byFirst.get("d")).toBeNull();
	});

	it("stops at the bound of searches, keeping the newest", async () => {
		const board = await makeArtifact("canvas", "Board");
		for (let index = 0; index < CHAT_BLOCKS_PER_KIND + 3; index += 1) {
			seedMessage({
				at: index + 1,
				toolCalls: [
					photosCall(
						[`search-${index}`],
						{},
						{ action: "search", query: `q${index}` },
					),
				],
			});
		}

		const listing = await listFor(board);

		expect(listing?.photos).toHaveLength(CHAT_BLOCKS_PER_KIND);
		expect(listing?.photos[0].query).toBe(`q${CHAT_BLOCKS_PER_KIND + 2}`);
	});

	it("caps one block at the photos the board's schema allows, instead of offering a block that vanishes on save", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			toolCalls: [
				photosCall(Array.from({ length: 80 }, (_, index) => `many-${index}`)),
			],
		});

		const listing = await listFor(board);

		expect(listing?.photos).toHaveLength(1);
		expect(listing?.photos[0].data.items).toHaveLength(50);
	});
});

describe("web searches", () => {
	it("lists what a research_web call returned with the query it ran, stamped with the time the chat searched", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ at: 7, toolCalls: [researchCall(3)] });

		const listing = await listFor(board);

		expect(listing?.searches).toHaveLength(1);
		const search = listing?.searches[0];
		expect(search?.at).toBe(minute(7).getTime());
		expect(search?.data).toMatchObject({
			kind: "liveweb",
			query: "cork weather this weekend",
			fetchedAt: minute(7).getTime(),
		});
		expect(search?.data.sources).toHaveLength(3);
		expect(search?.data.sources[0]).toEqual({
			id: "src-1",
			title: "Result 1",
			url: "https://example.com/page-1",
			provider: "parallel",
			authorityClass: "primary",
			authorityScore: 0.89,
			publishedAt: "2026-09-01",
			updatedAt: null,
			snippet: "About result 1.",
		});
	});

	it("takes only finished research_web calls that returned sources, and web sources alone", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			toolCalls: [
				researchCall(2, { status: "failed" }),
				researchCall(2, { status: "running" }),
				researchCall(2, { metadata: { ok: false } }),
				researchCall(0),
				researchCall(2, { name: "fetch_url" }),
				researchCall(2, { name: "photos" }),
				{
					...researchCall(2),
					candidates: [webCandidate(1, { sourceType: "tool" })],
				},
				{ type: "text", content: "thinking" },
			],
		});

		expect((await listFor(board))?.searches).toEqual([]);
	});

	it("keeps a source only if its link is a web address, and drops a search that has none left", async () => {
		const board = await makeArtifact("canvas", "Board");
		const mixed = researchCall(1);
		mixed.candidates = [
			webCandidate(1),
			webCandidate(2, { url: "javascript:alert(1)" }),
			webCandidate(3, { url: "data:text/html,<script>alert(1)</script>" }),
			webCandidate(4, { url: "//evil.example/x" }),
			webCandidate(5, { url: "https://example.com/has space" }),
			webCandidate(6),
		];
		const onlyBad = researchCall(1, {}, "only bad");
		onlyBad.candidates = [webCandidate(1, { url: "javascript:alert(1)" })];
		seedMessage({ toolCalls: [mixed, onlyBad] });

		const listing = await listFor(board);

		expect(listing?.searches).toHaveLength(1);
		expect(
			listing?.searches[0].data.sources.map((source) => source.id),
		).toEqual(["src-1", "src-6"]);
	});

	it("lists a source once even when a page read returned it again, and fills what an older record does not have", async () => {
		const board = await makeArtifact("canvas", "Board");
		const call = researchCall(1);
		call.candidates = [
			webCandidate(1),
			webCandidate(1, { id: "page-1" }),
			{
				id: "old-1",
				title: "Older record",
				url: "https://example.org/older",
				snippet: null,
				sourceType: "web",
			},
		];
		seedMessage({ toolCalls: [call] });

		const listing = await listFor(board);

		expect(listing?.searches[0].data.sources).toHaveLength(2);
		expect(listing?.searches[0].data.sources[1]).toEqual({
			id: "old-1",
			title: "Older record",
			url: "https://example.org/older",
			provider: "",
			authorityClass: "unknown",
			authorityScore: 0,
			publishedAt: null,
			updatedAt: null,
		});
	});

	it("leaves out a search whose query a block could not keep whole, since a refresh runs exactly the stored query", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({
			toolCalls: [
				researchCall(2, {}, "x".repeat(501)),
				researchCall(2, {}, "   "),
				{ ...researchCall(2), input: {} },
				{ ...researchCall(2), input: { query: 42 } },
				researchCall(2, {}, "  kept query  "),
			],
		});

		const listing = await listFor(board);

		expect(listing?.searches.map((search) => search.data.query)).toEqual([
			"kept query",
		]);
	});

	it("shows a query the chat searched more than once as one row, at its newest run", async () => {
		const board = await makeArtifact("canvas", "Board");
		seedMessage({ at: 1, toolCalls: [researchCall(2, {}, "Cork weather")] });
		seedMessage({ at: 2, toolCalls: [researchCall(3, {}, "something else")] });
		seedMessage({ at: 3, toolCalls: [researchCall(4, {}, "cork  weather ")] });

		const listing = await listFor(board);

		expect(listing?.searches.map((search) => search.data.query)).toEqual([
			"cork  weather",
			"something else",
		]);
		expect(listing?.searches[0].data.sources).toHaveLength(4);
	});

	it("stops at the bound, keeping the newest, and at the sources one block may hold", async () => {
		const board = await makeArtifact("canvas", "Board");
		for (let index = 0; index < CHAT_BLOCKS_PER_KIND + 3; index += 1) {
			seedMessage({
				at: index + 1,
				toolCalls: [researchCall(2, {}, `query ${index}`)],
			});
		}
		seedMessage({
			at: 500,
			toolCalls: [researchCall(70, {}, "very wide search")],
		});

		const listing = await listFor(board);

		expect(listing?.searches).toHaveLength(CHAT_BLOCKS_PER_KIND);
		expect(listing?.searches[0].data.query).toBe("very wide search");
		expect(listing?.searches[0].data.sources).toHaveLength(50);
	});
});
