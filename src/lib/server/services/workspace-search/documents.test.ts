import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import { serializeImageVersionBody } from "$lib/shared/artifacts/image-body";
import { serializeVideoVersionBody } from "$lib/shared/artifacts/video-body";
import {
	searchTerms,
	typedSearchWords,
} from "$lib/shared/workspace-search-text";
import { seedUser } from "../artifacts/artifacts.test-helpers";
import type { WorkspaceSearchScope } from "./types";

// Document, picture, video and app search on a real, fully migrated database:
// the SQL picks the candidates inside the ownership scope, so only a real
// SQLite can prove what is found, by which field, and what never is.
let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { recentDocuments, searchDocuments, searchKindAndBadge } = await import(
	"./documents"
);

const OWNER = "owner";
const STRANGER = "stranger";
const CHAT = "chat-owner";
const CHAT_TITLE = "Cover ideas";
const THEIR_CHAT = "chat-theirs";
const BASE = new Date("2026-09-20T10:00:00.000Z");

function minutes(count: number): Date {
	return new Date(BASE.getTime() + count * 60_000);
}

function words(text: string) {
	return { terms: searchTerms(text), words: typedSearchWords(text) };
}

async function find(text: string, scope: WorkspaceSearchScope = "all") {
	return searchDocuments(OWNER, words(text), scope, { offset: 0, limit: 50 });
}

async function foundIds(text: string, scope: WorkspaceSearchScope = "all") {
	return (await find(text, scope)).results.map((row) => row.displayArtifactId);
}

type ArtifactSeed = {
	id: string;
	type: string;
	name: string;
	userId?: string;
	conversationId?: string | null;
	metadata?: Record<string, unknown>;
	contentText?: string | null;
	summary?: string | null;
	mimeType?: string | null;
	updatedAt?: Date;
};

function addArtifact(seed: ArtifactSeed): void {
	memory.db
		.insert(schema.artifacts)
		.values({
			id: seed.id,
			userId: seed.userId ?? OWNER,
			conversationId:
				seed.conversationId === undefined ? CHAT : seed.conversationId,
			type: seed.type,
			retrievalClass: "durable",
			name: seed.name,
			mimeType: seed.mimeType ?? null,
			contentText: seed.contentText ?? null,
			summary: seed.summary ?? null,
			metadataJson: seed.metadata ? JSON.stringify(seed.metadata) : null,
			createdAt: BASE,
			updatedAt: seed.updatedAt ?? BASE,
		})
		.run();
}

/** Many rows at once, so a test can fill a candidate cap without a thousand statements. */
function addArtifacts(seeds: ArtifactSeed[]): void {
	for (let start = 0; start < seeds.length; start += 100) {
		memory.db
			.insert(schema.artifacts)
			.values(
				seeds.slice(start, start + 100).map((seed) => ({
					id: seed.id,
					userId: seed.userId ?? OWNER,
					conversationId:
						seed.conversationId === undefined ? CHAT : seed.conversationId,
					type: seed.type,
					retrievalClass: "durable",
					name: seed.name,
					mimeType: seed.mimeType ?? null,
					contentText: seed.contentText ?? null,
					summary: seed.summary ?? null,
					metadataJson: seed.metadata ? JSON.stringify(seed.metadata) : null,
					createdAt: BASE,
					updatedAt: seed.updatedAt ?? BASE,
				})),
			)
			.run();
	}
}

type FamilyExtra = Partial<
	Pick<
		ArtifactSeed,
		"contentText" | "summary" | "conversationId" | "updatedAt" | "userId"
	>
>;

function addFamily(
	id: string,
	kind: string,
	name: string,
	extra: FamilyExtra = {},
): void {
	addArtifact({
		id,
		type: "artifact",
		name,
		metadata: { artifactType: kind, title: name },
		contentText: extra.contentText ?? `${name} body`,
		...extra,
	});
}

function imageBody(prompt: string, fileId = "file-image"): string {
	return serializeImageVersionBody({
		v: 1,
		fileId,
		width: 1248,
		height: 832,
		hasAlpha: false,
		baseFileId: null,
		sources: [],
		marks: null,
		prompt,
		takeId: null,
		seed: 424242,
		anchorFileId: null,
		chainSinceAnchor: 0,
	});
}

function videoBody(fileId = "file-clip", durationMs = 6000): string {
	return serializeVideoVersionBody({
		v: 1,
		fileId,
		posterFileId: fileId,
		width: 1280,
		height: 704,
		durationMs,
		sourceFileId: null,
	});
}

function addVideoJob(
	artifactId: string,
	prompt: string,
	column: "artifactId" | "createdArtifactId" = "artifactId",
): void {
	memory.db
		.insert(schema.videoJobs)
		.values({
			id: `job-${artifactId}-${column}`,
			userId: OWNER,
			conversationId: CHAT,
			...(column === "artifactId"
				? { artifactId }
				: { createdArtifactId: artifactId }),
			origin: "turn",
			requestJson: JSON.stringify({
				v: 1,
				prompt,
				durationSeconds: 5,
				sourceFileId: null,
				fromText: true,
				title: "A clip",
				summary: null,
				artifactId: null,
				explicitVariant: false,
			}),
			seed: 7,
			status: "succeeded",
			createdAt: BASE,
		})
		.run();
}

function addDescription(artifactId: string, description: string): void {
	memory.db
		.insert(schema.imageDescriptions)
		.values({
			artifactId,
			userId: OWNER,
			description,
			modelName: "test-model",
			createdAt: BASE,
		})
		.run();
}

function addUpload(
	id: string,
	name: string,
	mimeType: string,
	extra: { text?: string; summary?: string; updatedAt?: Date } = {},
): void {
	addArtifact({
		id,
		type: "source_document",
		name,
		mimeType,
		updatedAt: extra.updatedAt,
	});
	if (extra.text !== undefined || extra.summary !== undefined) {
		addArtifact({
			id: `${id}-text`,
			type: "normalized_document",
			name,
			contentText: extra.text ?? null,
			summary: extra.summary ?? null,
			updatedAt: extra.updatedAt,
		});
		memory.db
			.insert(schema.artifactLinks)
			.values({
				id: `link-${id}`,
				userId: OWNER,
				artifactId: `${id}-text`,
				relatedArtifactId: id,
				linkType: "derived_from",
				createdAt: BASE,
			})
			.run();
	}
}

function addGenerated(
	id: string,
	name: string,
	extra: {
		label?: string;
		role?: string;
		originMessage?: string;
		minutes?: number;
		contentText?: string;
		summary?: string;
	} = {},
): void {
	addArtifact({
		id,
		type: "generated_output",
		name,
		mimeType: "application/pdf",
		contentText: extra.contentText ?? null,
		summary: extra.summary ?? null,
		updatedAt: minutes(extra.minutes ?? 0),
		metadata: {
			sourceChatFileId: `file-${id}`,
			documentFamilyId: `family-${id}`,
			...(extra.label ? { documentLabel: extra.label } : {}),
			...(extra.role ? { documentRole: extra.role } : {}),
			originConversationId: CHAT,
			...(extra.originMessage
				? { originAssistantMessageId: extra.originMessage }
				: {}),
		},
	});
}

function item(
	overrides: Partial<KnowledgeDocumentItem>,
): KnowledgeDocumentItem {
	return {
		id: "doc-1",
		type: "source_document",
		displayArtifactId: "doc-1",
		promptArtifactId: null,
		familyArtifactIds: ["doc-1"],
		name: "Notes.pdf",
		mimeType: "application/pdf",
		sizeBytes: 1024,
		conversationId: null,
		summary: null,
		normalizedAvailable: false,
		documentOrigin: "uploaded",
		createdAt: 100,
		updatedAt: 100,
		...overrides,
	};
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	for (const [id, userId, title] of [
		[CHAT, OWNER, CHAT_TITLE],
		[THEIR_CHAT, STRANGER, "Their chat"],
	] as const) {
		memory.db
			.insert(schema.conversations)
			.values({
				id,
				userId,
				title,
				createdAt: BASE,
				updatedAt: BASE,
			})
			.run();
	}
});

afterEach(() => {
	memory.close();
});

describe("searchKindAndBadge", () => {
	it("classifies every kind", () => {
		const rows: Array<
			[string, Partial<KnowledgeDocumentItem>, string, string]
		> = [
			["app", { kind: "app", documentOrigin: undefined }, "apps", "app"],
			["image", { kind: "image", documentOrigin: undefined }, "media", "image"],
			["video", { kind: "video", documentOrigin: undefined }, "media", "video"],
			[
				"uploaded picture",
				{ mimeType: "image/png", documentOrigin: "uploaded" },
				"media",
				"image",
			],
			[
				"uploaded video",
				{ mimeType: "video/mp4", documentOrigin: "uploaded" },
				"media",
				"video",
			],
			[
				"slides",
				{ kind: "slides", documentOrigin: undefined },
				"documents",
				"slides",
			],
			[
				"canvas",
				{ kind: "canvas", documentOrigin: undefined },
				"documents",
				"canvas",
			],
			[
				"document",
				{ kind: "document", documentOrigin: undefined },
				"documents",
				"document",
			],
			[
				"skill note",
				{ documentOrigin: "skill_note", mimeType: null },
				"documents",
				"skill_note",
			],
			[
				"research report",
				{
					documentOrigin: "generated",
					documentRole: "Atlas research report · job 9f3c",
				},
				"documents",
				"report",
			],
			[
				"generated file",
				{ documentOrigin: "generated", documentRole: "Quarterly figures" },
				"documents",
				"generated",
			],
			[
				"generated file with no role",
				{ documentOrigin: "generated" },
				"documents",
				"generated",
			],
			[
				"generated picture file stays a generated file",
				{ documentOrigin: "generated", mimeType: "image/png" },
				"documents",
				"generated",
			],
			[
				"uploaded pdf",
				{ documentOrigin: "uploaded", mimeType: "application/pdf" },
				"documents",
				"uploaded",
			],
			[
				"anything else",
				{ documentOrigin: undefined, mimeType: null },
				"documents",
				"uploaded",
			],
		];
		for (const [label, overrides, searchKind, badge] of rows) {
			expect(searchKindAndBadge(item(overrides)), label).toEqual({
				searchKind,
				badge,
			});
		}
	});
});

describe("searchDocuments", () => {
	it("finds a picture by its prompt, not by its JSON", async () => {
		addFamily("image-1", "image", "Cosy living room", {
			contentText: imageBody("timber house in soft light"),
		});
		expect(await foundIds("timber")).toEqual(["image-1"]);
		expect(await foundIds("living room")).toEqual(["image-1"]);
		for (const jsonWord of [
			"seed",
			"width",
			"prompt",
			"fileId",
			"artifactType",
			"hasAlpha",
			"424242",
		]) {
			expect(await foundIds(jsonWord), jsonWord).toEqual([]);
		}
	});

	it("finds an edited picture by an earlier take's prompt, never by a take's JSON", async () => {
		addFamily("image-2", "image", "Cabin", {
			contentText: imageBody("make it night"),
		});
		const takes = [
			{ number: 1, prompt: "a timber cabin by a quiet lake" },
			{ number: 2, prompt: "make it night" },
		];
		for (const take of takes) {
			memory.db
				.insert(schema.artifactVersions)
				.values({
					id: `image-2-v${take.number}`,
					artifactId: "image-2",
					userId: OWNER,
					versionNumber: take.number,
					author: "assistant",
					summary: "",
					body: imageBody(take.prompt, `file-${take.number}`),
					bodyHash: `hash-${take.number}`,
					createdAt: minutes(take.number),
				})
				.run();
		}
		// A take another person wrote on this picture's id is never read.
		memory.db
			.insert(schema.artifactVersions)
			.values({
				id: "image-2-stranger",
				artifactId: "image-2",
				userId: STRANGER,
				versionNumber: 3,
				author: "assistant",
				summary: "",
				body: imageBody("a stranger's zeppelin", "file-3"),
				bodyHash: "hash-3",
				createdAt: minutes(3),
			})
			.run();
		expect(await foundIds("zeppelin")).toEqual([]);
		expect(await foundIds("lake")).toEqual(["image-2"]);
		expect(await foundIds("night")).toEqual(["image-2"]);
		const [row] = (await find("lake")).results;
		expect(row.match.snippet).toContain("timber cabin by a quiet lake");
		for (const jsonWord of ["seed", "prompt", "file-1", "424242"]) {
			expect(await foundIds(jsonWord), jsonWord).toEqual([]);
		}
	});

	it("finds a canvas by its words, not by its JSON", async () => {
		addFamily("canvas-1", "canvas", "Weekend board", {
			contentText: JSON.stringify({
				version: 1,
				nodes: [
					{
						id: "n1",
						type: "sticky",
						position: { x: 1, y: 2 },
						data: { kind: "sticky", text: "dovetail joints", tone: "yellow" },
					},
					{
						id: "n2",
						type: "frame",
						position: { x: 0, y: 0 },
						data: { kind: "frame", label: "Joinery", width: 300, height: 200 },
					},
				],
				edges: [],
				viewport: { x: 0, y: 0, zoom: 1 },
				annotations: [],
			}),
		});
		expect(await foundIds("dovetail")).toEqual(["canvas-1"]);
		expect(await foundIds("joinery dovetail")).toEqual(["canvas-1"]);
		for (const jsonWord of [
			"nodes",
			"label",
			"sticky",
			"frame",
			"position",
			"viewport",
			"annotations",
		]) {
			expect(await foundIds(jsonWord), jsonWord).toEqual([]);
		}
	});

	it("finds a canvas by the text of every kind of block, edge and note", async () => {
		const at = { x: 0, y: 0 };
		addFamily("canvas-1", "canvas", "Workshop board", {
			contentText: JSON.stringify({
				version: 1,
				nodes: [
					{
						id: "n-sticky",
						type: "sticky",
						position: at,
						data: { kind: "sticky", text: "dovetail joints", tone: "yellow" },
					},
					{
						id: "n-frame",
						type: "frame",
						position: at,
						data: { kind: "frame", label: "Joinery", width: 300, height: 200 },
					},
					{
						id: "n-list",
						type: "checklist",
						position: at,
						data: {
							kind: "checklist",
							label: "Shopping",
							items: [{ id: "i1", text: "order birch plywood", done: false }],
						},
					},
					{
						id: "n-chart",
						type: "chart",
						position: at,
						data: {
							kind: "chart",
							label: "Costs",
							subtitle: "per month in forints",
							code: "{}",
						},
					},
					{
						id: "n-app",
						type: "app",
						position: at,
						data: { kind: "app", artifactId: "app-9", title: "Cut calculator" },
					},
					{
						id: "n-photo",
						type: "photo",
						position: at,
						data: {
							kind: "photo",
							items: [
								{
									id: "p1",
									imageUrl: "/api/knowledge/photo-9/thumbnail",
									alt: "walnut offcuts",
								},
							],
						},
					},
					{
						id: "n-web",
						type: "liveweb",
						position: at,
						data: {
							kind: "liveweb",
							query: "chisel sharpening",
							sources: [],
							fetchedAt: 1,
						},
					},
					{
						id: "n-map",
						type: "map",
						position: at,
						data: {
							kind: "map",
							route: "workshop to timber yard",
							map: {
								bounds: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
								attribution: "OpenStreetMap",
							},
						},
					},
					{
						id: "n-file",
						type: "file",
						position: at,
						data: {
							kind: "file",
							fileId: "file-9",
							name: "cut-list.pdf",
							mime: "application/pdf",
							bytes: 10,
							label: "PDF",
						},
					},
				],
				edges: [
					{ id: "e1", source: "n-sticky", target: "n-list", label: "then buy" },
				],
				viewport: { x: 0, y: 0, zoom: 1 },
				annotations: [
					{
						id: "a1",
						kind: "text",
						color: "red",
						size: 2,
						at,
						text: "check the grain",
					},
				],
			}),
		});
		for (const word of [
			"dovetail",
			"joinery",
			"plywood",
			"shopping",
			"forints",
			"calculator",
			"walnut",
			"chisel",
			"timber yard",
			"cut-list",
			"then buy",
			"grain",
		]) {
			expect(await foundIds(word), word).toEqual(["canvas-1"]);
		}
		// The words are the board's own, never its structure.
		for (const jsonWord of [
			"checklist",
			"liveweb",
			"imageUrl",
			"fileId",
			"artifactId",
			"tone",
			"edges",
			"thumbnail",
			"OpenStreetMap",
		]) {
			expect(await foundIds(jsonWord), jsonWord).toEqual([]);
		}
	});

	it("is not undone by a board whose nodes are not objects", async () => {
		addFamily("odd-board", "canvas", "Odd board", {
			contentText: JSON.stringify({
				version: 1,
				nodes: ["a stray string", 5, null],
				edges: [],
				annotations: [],
			}),
		});
		addFamily("garden-board", "canvas", "Garden board", {
			contentText: JSON.stringify({
				version: 1,
				nodes: [
					{
						id: "n1",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: { kind: "sticky", text: "compost heap", tone: "mint" },
					},
				],
			}),
		});
		expect(await foundIds("compost")).toEqual(["garden-board"]);
	});

	it("finds a video by its prompt", async () => {
		addFamily("video-1", "video", "Clip seven", { contentText: videoBody() });
		addVideoJob(
			"video-1",
			"a slow turntable of the thesis model in soft daylight",
		);
		expect(await foundIds("turntable")).toEqual(["video-1"]);
		expect(await foundIds("thesis daylight")).toEqual(["video-1"]);
		for (const jsonWord of [
			"durationSeconds",
			"explicitVariant",
			"fromText",
			"prompt",
			"succeeded",
		]) {
			expect(await foundIds(jsonWord), jsonWord).toEqual([]);
		}
	});

	it("finds a video by the prompt of the take that made it", async () => {
		addFamily("video-2", "video", "Clip eight", { contentText: videoBody() });
		addVideoJob("video-2", "harbour lights at dusk", "createdArtifactId");
		expect(await foundIds("harbour")).toEqual(["video-2"]);
	});

	it("never reads another person's video takes", async () => {
		addFamily("video-3", "video", "Clip nine", { contentText: videoBody() });
		memory.db
			.insert(schema.videoJobs)
			.values({
				id: "job-theirs",
				userId: STRANGER,
				conversationId: THEIR_CHAT,
				artifactId: "video-3",
				origin: "turn",
				requestJson: JSON.stringify({
					v: 1,
					prompt: "secret submarine footage",
					durationSeconds: 5,
					sourceFileId: null,
					fromText: true,
					title: "A clip",
					summary: null,
					artifactId: null,
					explicitVariant: false,
				}),
				seed: 1,
				status: "succeeded",
				createdAt: BASE,
			})
			.run();
		expect(await foundIds("submarine")).toEqual([]);
	});

	it("finds an uploaded picture by what Alfy saw in it", async () => {
		addUpload("photo-1", "IMG_0042.png", "image/png");
		addDescription("photo-1", "a red bicycle leaning on a brick wall");
		const found = await find("bicycle");
		expect(found.results.map((row) => row.displayArtifactId)).toEqual([
			"photo-1",
		]);
		expect(found.results[0]).toMatchObject({
			searchKind: "media",
			badge: "image",
			preview: null,
		});
		expect(found.totals).toEqual({ documents: 0, media: 1, apps: 0 });
	});

	it("never searches an App's code", async () => {
		addFamily("app-1", "app", "Countdown", {
			contentText:
				"<html><script>const [count, setCount] = useState(0)</script></html>",
		});
		expect(await foundIds("useState")).toEqual([]);
		expect(await foundIds("script")).toEqual([]);
		expect(await foundIds("countdown")).toEqual(["app-1"]);
		expect((await find("countdown")).results[0]).toMatchObject({
			searchKind: "apps",
			badge: "app",
		});
	});

	it("searches an App's summary, never its code", async () => {
		addFamily("app-2", "app", "Splitter", {
			contentText: "<div>kumquat</div>",
			summary: "Splits a restaurant bill",
		});
		expect(await foundIds("restaurant")).toEqual(["app-2"]);
		expect(await foundIds("kumquat")).toEqual([]);
	});

	it("keeps a research report under Documents with the Report badge", async () => {
		addGenerated("report-1", "report-one.pdf", {
			label: "Timber housing in Portugal",
			role: "Atlas research report · job 9f3c2e41",
		});
		addGenerated("file-1", "thesis-timeline.xlsx", { role: "Timeline" });
		const found = await find("timber housing");
		expect(found.results.map((row) => row.displayArtifactId)).toEqual([
			"report-1",
		]);
		expect(found.results[0]).toMatchObject({
			searchKind: "documents",
			badge: "report",
			match: { type: "label" },
		});
		const plain = await find("timeline");
		expect(plain.results[0]).toMatchObject({
			displayArtifactId: "file-1",
			searchKind: "documents",
			badge: "generated",
		});
	});

	it("never matches a report's job id or any other metadata", async () => {
		addGenerated("report-2", "findings.pdf", {
			role: "Atlas research report · job 9f3c2e41",
		});
		expect(await foundIds("9f3c2e41")).toEqual([]);
		expect(await foundIds("sourceChatFileId")).toEqual([]);
		expect(await foundIds("documentFamilyId")).toEqual([]);
		expect(await foundIds("findings")).toEqual(["report-2"]);
	});

	it("a word deep in a long upload still counts", async () => {
		addUpload("long-1", "Handbook.pdf", "application/pdf", {
			text: `${"lorem ipsum dolor ".repeat(2800)}needlepoint ${"sit amet ".repeat(500)}`,
		});
		const found = await find("needlepoint");
		expect(found.results.map((row) => row.displayArtifactId)).toEqual([
			"long-1",
		]);
		const [row] = found.results;
		expect(row.match.type).toBe("content");
		expect(row.match.snippet).toContain("needlepoint");
		expect((row.match.snippet ?? "").length).toBeLessThanOrEqual(162);
		expect(row.badge).toBe("uploaded");
	});

	it("opens where it does today", async () => {
		addFamily("doc-1", "document", "Orchard plan");
		addFamily("canvas-1", "canvas", "Orchard board");
		addFamily("app-1", "app", "Orchard timer");
		addFamily("image-1", "image", "Orchard picture", {
			contentText: imageBody("an orchard"),
		});
		addUpload("up-1", "Orchard contract.pdf", "application/pdf", {
			text: "Terms of the orchard lease",
		});
		const hrefs = new Map(
			(await find("orchard")).results.map((row) => [
				row.displayArtifactId,
				row.href,
			]),
		);
		expect(hrefs.get("doc-1")).toBe(
			"/knowledge?open_artifact=doc-1&open_filename=Orchard+plan",
		);
		expect(hrefs.get("canvas-1")).toBe(
			"/knowledge?open_artifact=canvas-1&open_filename=Orchard+board",
		);
		expect(hrefs.get("app-1")).toBe(
			"/knowledge?open_artifact=app-1&open_filename=Orchard+timer",
		);
		expect(hrefs.get("image-1")).toBe(
			"/knowledge?open_artifact=image-1&open_filename=Orchard+picture",
		);
		expect(hrefs.get("up-1")).toBe(
			"/knowledge?open_artifact=up-1&open_filename=Orchard+contract.pdf&open_mime=application%2Fpdf",
		);
	});

	it("counts per kind", async () => {
		for (const index of [1, 2, 3]) {
			addFamily(`image-${index}`, "image", `Orchard picture ${index}`, {
				contentText: imageBody("trees"),
			});
		}
		for (const index of [1, 2]) {
			addFamily(`video-${index}`, "video", `Orchard clip ${index}`, {
				contentText: videoBody(),
			});
		}
		for (const index of [1, 2, 3, 4]) {
			addFamily(`doc-${index}`, "document", `Orchard note ${index}`);
		}
		addFamily("app-1", "app", "Orchard timer");
		const found = await find("orchard");
		expect(found.totals).toEqual({ media: 5, documents: 4, apps: 1 });
		// "All" shows three per kind and no more.
		const perKind = new Map<string, number>();
		for (const row of (
			await searchDocuments(OWNER, words("orchard"), "all", {
				offset: 0,
				limit: 3,
			})
		).results) {
			perKind.set(row.searchKind, (perKind.get(row.searchKind) ?? 0) + 1);
		}
		expect(Object.fromEntries(perKind)).toEqual({
			media: 3,
			documents: 3,
			apps: 1,
		});
	});

	it("pages one kind from an offset, with its true count", async () => {
		for (let index = 0; index < 25; index++) {
			addFamily(`doc-${index}`, "document", `Orchard note ${index}`, {
				updatedAt: minutes(index),
			});
		}
		addFamily("app-1", "app", "Orchard timer");
		const first = await searchDocuments(OWNER, words("orchard"), "documents", {
			offset: 0,
			limit: 20,
		});
		expect(first.results).toHaveLength(20);
		expect(first.hasMore).toBe(true);
		expect(first.totals.documents).toBe(25);
		expect(first.results.every((row) => row.searchKind === "documents")).toBe(
			true,
		);
		const second = await searchDocuments(OWNER, words("orchard"), "documents", {
			offset: 20,
			limit: 20,
		});
		expect(second.results).toHaveLength(5);
		expect(second.hasMore).toBe(false);
		const ids = [...first.results, ...second.results].map(
			(row) => row.displayArtifactId,
		);
		expect(new Set(ids).size).toBe(25);
		const apps = await searchDocuments(OWNER, words("orchard"), "apps", {
			offset: 0,
			limit: 20,
		});
		expect(apps.results.map((row) => row.displayArtifactId)).toEqual(["app-1"]);
	});

	it("stops counting at the cap", async () => {
		for (let index = 0; index < 130; index++) {
			addFamily(`doc-${index}`, "document", `Orchard note ${index}`);
		}
		const found = await searchDocuments(OWNER, words("orchard"), "documents", {
			offset: 0,
			limit: 20,
		});
		expect(found.totals.documents).toBe(100);
		expect(found.results).toHaveLength(20);
		expect(found.hasMore).toBe(true);
	});

	it("finds a name typed without accents, in any case", async () => {
		addFamily("doc-1", "document", "Árvíztűrő jegyzet");
		for (const typed of ["arviz", "ÁRVÍZ", "jegyzet arviz", "ÁrVíZ"]) {
			expect(await foundIds(typed), typed).toEqual(["doc-1"]);
		}
	});

	it("finds an accented capital in a long text", async () => {
		addUpload("up-1", "Jegyzetek.pdf", "application/pdf", {
			text: "Az Árvíztűrő tükörfúrógép kell",
		});
		const found = await find("árvíz");
		expect(found.results.map((row) => row.displayArtifactId)).toEqual(["up-1"]);
		expect(found.results[0].match.snippet).toContain("Árvíztűrő");
	});

	it("finds an upload's text typed without accents, through the index", async () => {
		addUpload("up-2", "Jegyzet.pdf", "application/pdf", {
			text: "Az Árvíztűrő tükörfúrógép kell",
		});
		const found = await find("arviz");
		expect(found.results.map((row) => row.displayArtifactId)).toEqual(["up-2"]);
		expect(found.results[0].match.type).toBe("content");
		expect(found.results[0].match.snippet).toContain("Árvíztűrő");
	});

	it("finds a Skill Note and a Slides by their text", async () => {
		addArtifact({
			id: "note-1",
			type: "skill_note",
			name: "Packing list",
			contentText: "pack the hiking boots and the stove",
		});
		addFamily("deck-1", "slides", "Quarterly deck", {
			contentText: "the harbour expansion plan, slide by slide",
		});
		const note = await find("hiking");
		expect(note.results.map((row) => row.displayArtifactId)).toEqual([
			"note-1",
		]);
		expect(note.results[0]).toMatchObject({
			searchKind: "documents",
			badge: "skill_note",
		});
		const deck = await find("harbour expansion");
		expect(deck.results.map((row) => row.displayArtifactId)).toEqual([
			"deck-1",
		]);
		expect(deck.results[0]).toMatchObject({
			searchKind: "documents",
			badge: "slides",
		});
	});

	it("keeps App code and picture, video and canvas JSON out of the index", async () => {
		addFamily("app-1", "app", "Countdown", {
			contentText: "<script>const [n, setN] = useState(0)</script>",
		});
		addFamily("img-1", "image", "Cabin", {
			contentText: imageBody("a timber house at dusk"),
		});
		addFamily("vid-1", "video", "Spin", { contentText: videoBody() });
		addFamily("board-1", "canvas", "Board", {
			contentText: JSON.stringify({ nodes: [{ id: "n1", text: "dovetail" }] }),
		});
		const indexed = (word: string) =>
			memory.sqlite
				.prepare(
					"SELECT count(*) FROM artifacts_fts WHERE artifacts_fts MATCH ?",
				)
				.pluck()
				.get(`"${word}"`);
		for (const word of [
			"usestate",
			"script",
			"timber",
			"prompt",
			"dovetail",
			"nodes",
			"file-clip",
		]) {
			expect(indexed(word)).toBe(0);
		}
		expect(
			memory.sqlite.prepare("SELECT count(*) FROM artifacts_fts").pluck().get(),
		).toBe(0);
		// Found by their own fields, never by the index.
		expect(await foundIds("timber")).toEqual(["img-1"]);
		expect(await foundIds("dovetail")).toEqual(["board-1"]);
		expect(await foundIds("usestate")).toEqual([]);
	});

	it("still finds a body by a two-letter word", async () => {
		addUpload("up-3", "Roadmap.pdf", "application/pdf", {
			text: "the AI roadmap for next year",
		});
		expect(await foundIds("ai")).toEqual(["up-3"]);
		expect(await foundIds("ai roadmap")).toEqual(["up-3"]);
	});

	it("takes words in any order and from different fields", async () => {
		addFamily("doc-1", "document", "Thesis plan", {
			contentText: "The joints are dovetail, cut by hand.",
		});
		addFamily("doc-2", "document", "Garden plan", {
			contentText: "Dovetail is not mentioned here.",
		});
		expect(await foundIds("dovetail thesis")).toEqual(["doc-1"]);
		expect(await foundIds("thesis dovetail")).toEqual(["doc-1"]);
		expect(await foundIds("thesis budget")).toEqual([]);
	});

	it("ranks a name above a summary above a body, and a newer one first among equals", async () => {
		addUpload("by-body", "Quarterly.pdf", "application/pdf", {
			text: "The kiln was fired twice",
			updatedAt: minutes(30),
		});
		addUpload("by-summary", "Minutes.pdf", "application/pdf", {
			summary: "About the kiln schedule",
			text: "Nothing else",
			updatedAt: minutes(20),
		});
		addFamily("by-name", "document", "Kiln notes", {
			updatedAt: minutes(10),
		});
		addFamily("by-name-newer", "document", "Kiln plan", {
			updatedAt: minutes(40),
		});
		const found = await find("kiln", "documents");
		expect(found.results.map((row) => row.displayArtifactId)).toEqual([
			"by-name-newer",
			"by-name",
			"by-summary",
			"by-body",
		]);
		expect(found.results.map((row) => row.match.type)).toEqual([
			"name",
			"name",
			"summary",
			"content",
		]);
	});

	it("puts a summary or prompt match on the row as a snippet", async () => {
		addFamily("image-1", "image", "Lamplight", {
			contentText: imageBody(
				"a cut-through section of a timber house for my thesis cover",
			),
		});
		addUpload("up-1", "Minutes.pdf", "application/pdf", {
			summary: "Notes about the harvest festival",
			text: "x",
		});
		const picture = (await find("thesis")).results[0];
		expect(picture.match.type).toBe("content");
		expect(picture.match.snippet).toContain("thesis");
		const summary = (await find("harvest")).results[0];
		expect(summary.match.type).toBe("summary");
		expect(summary.match.snippet).toContain("harvest festival");
	});

	it("shows a made picture's thumbnail, a video's poster and length, and where it was made", async () => {
		addFamily("image-1", "image", "Timber house", {
			contentText: imageBody("timber", "file-picture"),
		});
		addFamily("video-1", "video", "Timber turntable", {
			contentText: videoBody("file-clip", 6000),
		});
		addUpload("photo-1", "timber-photo.png", "image/png");
		addFamily("doc-1", "document", "Timber outline");
		addUpload("up-1", "timber-contract.pdf", "application/pdf", {
			text: "x",
		});
		const rows = new Map(
			(await find("timber")).results.map((row) => [row.displayArtifactId, row]),
		);
		expect(rows.get("image-1")?.preview).toEqual({
			src: "/api/images/files/file-picture?variant=thumb&conversationId=chat-owner",
			width: 1248,
			height: 832,
		});
		expect(rows.get("video-1")?.preview).toEqual({
			// The poster's 48-pixel row tile reads the small thumb, not the full poster.
			src: "/api/images/files/file-clip?variant=thumb&conversationId=chat-owner",
			width: 1280,
			height: 704,
		});
		expect(rows.get("video-1")?.durationMs).toBe(6000);
		expect(rows.get("image-1")?.durationMs).toBeNull();
		expect(rows.get("photo-1")?.preview).toBeNull();
		expect(rows.get("doc-1")?.preview).toBeNull();
		expect(rows.get("image-1")?.originConversationTitle).toBe(CHAT_TITLE);
		expect(rows.get("doc-1")?.originConversationTitle).toBe(CHAT_TITLE);
		// An upload was not made in a chat, so it is never "Made in" one.
		expect(rows.get("up-1")?.originConversationTitle).toBeNull();
		expect(rows.get("photo-1")?.originConversationTitle).toBeNull();
	});

	it("keeps the source-chat link of a generated file", async () => {
		addGenerated("file-1", "budget.pdf", {
			label: "Renovation budget",
			originMessage: "message-9",
		});
		const [row] = (await find("renovation")).results;
		expect(row.sourceHref).toBe("/chat/chat-owner?focus_message=message-9");
		expect(row.originConversationTitle).toBe(CHAT_TITLE);
	});

	it("never returns another person's material", async () => {
		addFamily("their-doc", "document", "Secret orchard", {
			userId: STRANGER,
			conversationId: THEIR_CHAT,
		});
		addArtifact({
			id: "their-upload",
			type: "source_document",
			name: "Secret orchard.pdf",
			userId: STRANGER,
			conversationId: THEIR_CHAT,
			mimeType: "application/pdf",
		});
		addDescription("their-upload", "orchard");
		expect(await foundIds("orchard")).toEqual([]);
		expect((await find("orchard")).totals).toEqual({
			documents: 0,
			media: 0,
			apps: 0,
		});
	});

	it("never lets another person's rows fill the candidate cap", async () => {
		addFamily("mine", "document", "Orchard plan", { updatedAt: minutes(0) });
		addArtifacts(
			Array.from({ length: 405 }, (_, index) => ({
				id: `their-${index}`,
				type: "artifact",
				name: `Orchard ${index}`,
				userId: STRANGER,
				conversationId: THEIR_CHAT,
				metadata: { artifactType: "document" },
				contentText: "orchard",
				updatedAt: minutes(100 + index),
			})),
		);
		expect(await foundIds("orchard")).toEqual(["mine"]);
	});

	it("keeps the best matches when a full cap of newer rows only mention the word", async () => {
		// The upload named for the word and the report labelled with it are old.
		// Newer rows have it only in their summary (405) or only in their text
		// (405 more). The cap keeps the strongest matches, not the newest.
		addUpload("by-name", "Budget 2024.pdf", "application/pdf", {
			updatedAt: minutes(0),
		});
		addGenerated("by-label", "Q3 report.pdf", { label: "Budget", minutes: 1 });
		addArtifacts([
			...Array.from({ length: 405 }, (_, index) => ({
				id: `summary-${index}`,
				type: "artifact",
				name: `Review ${index}`,
				metadata: { artifactType: "document" },
				summary: "Where the budget went",
				contentText: "numbers",
				updatedAt: minutes(100 + index),
			})),
			...Array.from({ length: 405 }, (_, index) => ({
				id: `mention-${index}`,
				type: "artifact",
				name: `Note ${index}`,
				metadata: { artifactType: "document" },
				contentText: "the budget is tight",
				updatedAt: minutes(600 + index),
			})),
		]);
		const found = await find("budget", "documents");
		expect(
			found.results
				.slice(0, 3)
				.map((row) => [row.displayArtifactId, row.match.type]),
		).toEqual([
			["by-name", "name"],
			["by-label", "label"],
			["summary-404", "summary"],
		]);
		expect(found.totals.documents).toBe(100);
	});

	it("never lets a JSON body or an app's code fill the candidate cap", async () => {
		addFamily("real-board", "canvas", "Fruit board", {
			contentText: JSON.stringify({
				version: 1,
				nodes: [
					{
						id: "n1",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: { kind: "sticky", text: "orchard crates", tone: "mint" },
					},
				],
			}),
			updatedAt: minutes(0),
		});
		addFamily("real-app", "app", "Orchard timer", { updatedAt: minutes(0) });
		addArtifacts([
			...Array.from({ length: 405 }, (_, index) => ({
				id: `junk-board-${index}`,
				type: "artifact",
				name: `Board ${index}`,
				metadata: { artifactType: "canvas" },
				contentText: JSON.stringify({
					version: 1,
					nodes: [
						{
							id: "n",
							type: "orchard",
							position: { x: 0, y: 0 },
							data: { kind: "orchard" },
						},
					],
				}),
				updatedAt: minutes(100 + index),
			})),
			...Array.from({ length: 405 }, (_, index) => ({
				id: `junk-app-${index}`,
				type: "artifact",
				name: `App ${index}`,
				metadata: { artifactType: "app" },
				contentText: "<script>const orchard = 1</script>",
				updatedAt: minutes(100 + index),
			})),
		]);
		expect((await foundIds("orchard")).sort()).toEqual([
			"real-app",
			"real-board",
		]);
	});

	it("treats the characters of a query as text, not as patterns", async () => {
		addFamily("doc-1", "document", "Rates", {
			contentText: "x_y and a*b and q[b]c and a%b",
		});
		addFamily("doc-2", "document", "Prices", {
			contentText: "xzy and axxb and qbc and axb",
		});
		expect(await foundIds("a%b")).toEqual(["doc-1"]);
		expect(await foundIds("x_y")).toEqual(["doc-1"]);
		expect(await foundIds("a*b")).toEqual(["doc-1"]);
		expect(await foundIds("q[b]c")).toEqual(["doc-1"]);
	});
});

describe("recentDocuments", () => {
	it("reads only the newest few, as one document each", async () => {
		for (let index = 0; index < 8; index++) {
			addFamily(`doc-${index}`, "document", `Note ${index}`, {
				updatedAt: minutes(index),
			});
		}
		addUpload("up-new", "Newest.pdf", "application/pdf", {
			text: "text",
			updatedAt: minutes(20),
		});
		const rows = await recentDocuments(OWNER, 3);
		expect(rows.map((row) => row.displayArtifactId)).toEqual([
			"up-new",
			"doc-7",
			"doc-6",
		]);
		expect(rows[0].match).toEqual({ type: "recent", snippet: null });
	});

	it("does not read the whole library to show three", async () => {
		for (let index = 0; index < 300; index++) {
			addFamily(`doc-${index}`, "document", `Note ${index}`, {
				updatedAt: minutes(index),
			});
		}
		// Count the rows SQLite hands back, whatever statements ask for them.
		let rowsRead = 0;
		const realPrepare = memory.sqlite.prepare.bind(memory.sqlite);
		vi.spyOn(memory.sqlite, "prepare").mockImplementation(((
			sqlText: string,
		) => {
			const statement = realPrepare(sqlText);
			const realAll = statement.all.bind(statement);
			statement.all = ((...args: unknown[]) => {
				const rows = realAll(...args);
				rowsRead += rows.length;
				return rows;
			}) as typeof statement.all;
			return statement;
		}) as typeof memory.sqlite.prepare);
		const rows = await recentDocuments(OWNER, 3);
		expect(rows.map((row) => row.displayArtifactId)).toEqual([
			"doc-299",
			"doc-298",
			"doc-297",
		]);
		expect(rowsRead).toBeGreaterThan(0);
		expect(rowsRead).toBeLessThan(120);
	});

	it("leaves out what the person cannot open", async () => {
		addFamily("their-doc", "document", "Theirs", {
			userId: STRANGER,
			conversationId: THEIR_CHAT,
			updatedAt: minutes(99),
		});
		addFamily("mine", "document", "Mine", { updatedAt: minutes(1) });
		expect(
			(await recentDocuments(OWNER, 3)).map((row) => row.displayArtifactId),
		).toEqual(["mine"]);
	});
});
