// "From this chat" (Feature 2 · Canvas): what a board's own conversation has
// that can be put on the board — its files, Apps, route maps and charts —
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

const EMPTY = { files: [], apps: [], maps: [], charts: [] };

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
		seedMessage({ conversationId: INCOGNITO, content: fence(CHART) });

		expect(await listFor(board)).toBeNull();
		expect(await listFor(board, OTHER_CONVERSATION)).toBeNull();
		const named = await listFor(board, INCOGNITO);
		expect(named?.charts).toHaveLength(1);
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
			toolCalls: [mapCall()],
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
