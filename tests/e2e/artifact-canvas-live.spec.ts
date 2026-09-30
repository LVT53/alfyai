import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { expect, type Page, type Route, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { conversations, messages } from "../../src/lib/server/db/schema";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import { emptyCanvasBody } from "../../src/lib/shared/artifacts/canvas-body";
import {
	openChatAndReload,
	savedStatus,
	seedCanvas,
	storedBoard,
	versionRows,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { createConversation, login, waitForStableBoundingBox } from "./helpers";

// Photos and live web on the board (Feature 2 · Canvas, S3-R2). The chat's photo
// searches and web searches are listed in the Insert menu and become blocks; a photo
// is only ever the app's own thumbnail and opens the chat's lightbox; a live-web
// block says how old its snapshot is and refreshes it. A chat is seeded straight into
// the database (the convention the other artifact specs use, since a tool call has no
// scriptable fixture).
//
// The search provider is never called: the browser's own requests to the two
// web-read routes are answered here (`page.route`), which is what the block and the
// menu are measured against. What the SERVER does with a read (who may ask, the
// stored query, what may come back, the throttle) is measured against the real route,
// service and database in the unit suites, and the guards that answer before any
// search is made are measured here against the real server.

const BEACH = [
	"asset-b1",
	"asset-b2",
	"asset-b3",
	"asset-b4",
	"asset-b5",
	"asset-b6",
	"asset-b7",
	"asset-b8",
];
const SUNSET = ["asset-s1", "asset-s2", "asset-s3"];
const PROXY = "/api/connections/immich/thumbnail/";

const FRESH_QUERY = "cork weather this weekend";
const OLD_QUERY = "salzburg museums opening hours";

// ── Seeding ─────────────────────────────────────────────────────────────────

let sequence = 500;

function photoCall(assetIds: string[], query: string) {
	sequence += 1;
	return {
		type: "tool_call",
		callId: `call-photos-${sequence}`,
		name: "photos",
		input: { action: "search", query },
		status: "done",
		metadata: { ok: true, action: "search", resultCount: assetIds.length },
		candidates: assetIds.map((id) => ({
			id: `photos:${id}`,
			// The chat keeps the real file name for the reader's own screen: it must
			// never reach the board.
			title: `holiday-${id}-private-name.jpg`,
			url: "",
			snippet: `holiday-${id}-private-name.jpg`,
			sourceType: "tool",
			metadata: { thumbnailPath: `/api/assets/${id}/thumbnail` },
		})),
	};
}

function searchCall(query: string, count: number) {
	sequence += 1;
	return {
		type: "tool_call",
		callId: `call-search-${sequence}`,
		name: "research_web",
		input: { query },
		status: "done",
		sourceType: "web",
		metadata: { ok: true, evidenceReady: true, sourceCount: count },
		candidates: Array.from({ length: count }, (_, index) => ({
			id: `src-${sequence}-${index}`,
			title: `Forecast source ${index + 1} for ${query}`,
			url: `https://weather${index + 1}.example.com/cork`,
			snippet: `What source ${index + 1} says about ${query}.`,
			sourceType: "web",
			material: true,
			metadata: {
				provider: "parallel",
				authorityClass: "primary",
				authorityScore: 0.9,
				providerRank: index + 1,
			},
		})),
	};
}

async function seedToolMessage(
	conversationId: string,
	toolCalls: unknown[],
	ageMs: number,
) {
	sequence += 1;
	await db.insert(messages).values({
		id: randomUUID(),
		conversationId,
		messageSequence: sequence,
		role: "assistant",
		content: "Here is what I found.",
		toolCalls: JSON.stringify(toolCalls),
		createdAt: new Date(Date.now() - ageMs),
	});
}

type Seeded = { conversationId: string; boardId: string };

/** A chat that ran two photo searches and two web searches (one of them hours old), and an empty board beside them. */
async function seedChat(
	page: Page,
	options: {
		title?: string;
		body?: CanvasBody;
		incognito?: boolean;
		/** Appended to every query, so two chats' work can be told apart. */
		tag?: string;
	} = {},
): Promise<Seeded> {
	const tag = options.tag ?? "";
	// A second chat in one test starts from the landing page, as a reader's would.
	await page.goto("/");
	const conversationId = await createConversation(
		page,
		options.title ?? "Photos and the web on a board",
	);
	if (options.incognito) {
		await db
			.update(conversations)
			.set({ memoryIncognito: true })
			.where(eq(conversations.id, conversationId));
	}
	const minutes = (n: number) => n * 60_000;
	// Oldest first: a message's place in the chat (its sequence) and its time agree,
	// as they do in a real chat, and the listing reads the newest first.
	await seedToolMessage(
		conversationId,
		[searchCall(`${OLD_QUERY}${tag}`, 3)],
		minutes(3 * 60),
	);
	await seedToolMessage(
		conversationId,
		[photoCall(SUNSET, `sunset${tag}`)],
		minutes(30),
	);
	await seedToolMessage(
		conversationId,
		[searchCall(`${FRESH_QUERY}${tag}`, 4)],
		minutes(5),
	);
	await seedToolMessage(
		conversationId,
		[photoCall(BEACH, `beach${tag}`)],
		minutes(2),
	);
	const boardId = await seedCanvas(
		conversationId,
		options.body ?? emptyCanvasBody(),
		"Board",
	);
	return { conversationId, boardId };
}

// ── A solid-colour PNG, so a stubbed thumbnail is a real image ───────────────

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		let c = (crc ^ byte) & 0xff;
		for (let bit = 0; bit < 8; bit += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		crc = (crc >>> 8) ^ c;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

function solidPng(size: number, [r, g, b]: [number, number, number]): Buffer {
	const stride = size * 3 + 1;
	const raw = Buffer.alloc(stride * size);
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const at = y * stride + 1 + x * 3;
			raw[at] = r;
			raw[at + 1] = g;
			raw[at + 2] = b;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

const PALETTE: [number, number, number][] = [
	[235, 160, 120],
	[120, 175, 225],
	[150, 205, 150],
	[225, 190, 90],
	[190, 140, 210],
	[100, 180, 180],
	[220, 130, 150],
	[160, 160, 200],
];

/** Answers the app's thumbnail proxy with a picture (one colour per photo), except for the assets named to fail. */
async function stubThumbnails(page: Page, failing: string[] = []) {
	await page.route(`**${PROXY}**`, async (route) => {
		const id = new URL(route.request().url()).pathname.split("/").pop() ?? "";
		if (failing.includes(id)) {
			await route.fulfill({ status: 404, body: "not found" });
			return;
		}
		const colour = PALETTE[
			[...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % PALETTE.length
		] as [number, number, number];
		await route.fulfill({
			status: 200,
			contentType: "image/png",
			body: solidPng(96, colour),
		});
	});
}

// ── The panel and the menu ──────────────────────────────────────────────────

async function openBoard(page: Page) {
	const isMobile = (page.viewportSize()?.width ?? 1440) < 768;
	const editor = page.getByTestId("canvas-editor");
	const alreadyShowing = await editor
		.waitFor({ state: "visible", timeout: 2_000 })
		.then(() => true)
		.catch(() => false);
	if (!alreadyShowing) {
		await page
			.getByTestId(
				isMobile ? "artifact-count-button-compact" : "artifact-count-button",
			)
			.click();
		await page
			.getByTestId(
				isMobile ? "artifact-panel-list-mobile" : "artifact-panel-list",
			)
			.getByTestId("artifact-row")
			.filter({ hasText: /Canvas|Tábla/ })
			.click();
	}
	await expect(editor).toBeVisible();
	await expect(page.getByTestId("canvas-board")).toBeVisible({
		timeout: 15_000,
	});
	// Svelte Flow reveals a node only once it has measured it.
	await expect(async () => {
		const hidden = await page
			.locator(".svelte-flow__node")
			.evaluateAll(
				(nodes) =>
					nodes.filter((node) => getComputedStyle(node).visibility === "hidden")
						.length,
			);
		expect(hidden).toBe(0);
	}).toPass({ timeout: 10_000 });
	await waitForStableBoundingBox(page.getByTestId("canvas-board"));
}

const insertButton = (page: Page) => page.getByTestId("canvas-insert-button");
const menu = (page: Page) => page.getByTestId("canvas-insert-menu-list");
const nodeOf = (page: Page, kind: string) =>
	page.locator(`[data-testid="canvas-node"][data-kind="${kind}"]`);

const SECTION = {
	en: { title: "From this chat", reading: "Looking through this chat…" },
	hu: { title: "Ebből a beszélgetésből", reading: "A beszélgetés átnézése…" },
} as const;

async function openInsertMenu(page: Page, language: "en" | "hu" = "en") {
	await insertButton(page).click();
	await expect(menu(page)).toBeVisible();
	await expect(
		menu(page).getByRole("group", { name: SECTION[language].title }),
	).toBeVisible();
	await expect(menu(page).getByText(SECTION[language].reading)).toHaveCount(0);
}

async function pickFromChat(
	page: Page,
	name: string | RegExp,
	language: "en" | "hu" = "en",
) {
	await openInsertMenu(page, language);
	await menu(page).getByRole("menuitem", { name }).click();
	await expect(menu(page)).toHaveCount(0);
}

async function fitBoard(page: Page) {
	await page.getByTestId("canvas-fit").click();
	await expect(page.getByTestId("canvas-zoom-level")).not.toHaveText("100%");
	await page.waitForTimeout(500);
}

// ── The two web-read routes, as the browser meets them ──────────────────────

type LiveWebData = {
	kind: "liveweb";
	query: string;
	sources: {
		id: string;
		title: string;
		url: string;
		provider: string;
		authorityClass: string;
		authorityScore: number;
		publishedAt: string | null;
		updatedAt: string | null;
		snippet?: string;
	}[];
	fetchedAt: number;
};

function freshSnapshot(query: string): LiveWebData {
	return {
		kind: "liveweb",
		query,
		fetchedAt: Date.now(),
		sources: [1, 2, 3].map((index) => ({
			id: `fresh-${index}`,
			title: `Brand new result ${index}`,
			url: `https://fresh${index}.example.org/cork`,
			provider: "parallel",
			authorityClass: "primary",
			authorityScore: 0.9,
			publishedAt: null,
			updatedAt: null,
			snippet: `Fresh snippet ${index}`,
		})),
	};
}

/** What the browser sent to a stubbed web-read route, kept for the test to look at. */
type Sent = {
	method: string;
	url: string;
	body: string | null;
	contentType: string | undefined;
};

async function stubRefresh(
	page: Page,
	answer: (nodeId: string) => { status: number; body: unknown },
	sent: Sent[] = [],
) {
	await page.route(
		"**/api/artifacts/*/blocks/*/refresh*",
		async (route: Route) => {
			const request = route.request();
			sent.push({
				method: request.method(),
				url: request.url(),
				body: request.postData(),
				contentType: request.headers()["content-type"],
			});
			const nodeId = decodeURIComponent(
				new URL(request.url()).pathname.split("/").slice(-2)[0] ?? "",
			);
			const { status, body } = answer(nodeId);
			await route.fulfill({
				status,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		},
	);
	return sent;
}

async function stubSearch(
	page: Page,
	answer: (query: string) => { status: number; body: unknown },
	sent: Sent[] = [],
) {
	await page.route(
		"**/api/artifacts/*/blocks/liveweb*",
		async (route: Route) => {
			const request = route.request();
			sent.push({
				method: request.method(),
				url: request.url(),
				body: request.postData(),
				contentType: request.headers()["content-type"],
			});
			const query =
				(JSON.parse(request.postData() ?? "{}") as { query?: string }).query ??
				"";
			const { status, body } = answer(query);
			await route.fulfill({
				status,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		},
	);
	return sent;
}

test.describe("photos and live web on the board", () => {
	test.beforeEach(async ({ page }) => {
		await setUiLanguage("en");
		await login(page);
	});

	test("lists the chat's photo searches and web searches in the Insert menu, newest first, and a row to search the web", async ({
		page,
	}) => {
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);

		await openInsertMenu(page);
		const list = menu(page);
		const photos = list.getByRole("group", { name: "Photos" });
		const searches = list.getByRole("group", { name: "Web searches" });
		await expect(photos).toBeVisible();
		await expect(searches).toBeVisible();
		await expect(photos.getByRole("menuitem").nth(0)).toContainText(
			/beach.*8 photos/,
		);
		await expect(photos.getByRole("menuitem").nth(1)).toContainText(
			/sunset.*3 photos/,
		);
		await expect(searches.getByRole("menuitem").nth(0)).toContainText(
			new RegExp(`${FRESH_QUERY}.*4 sources`),
		);
		await expect(searches.getByRole("menuitem").nth(1)).toContainText(
			new RegExp(`${OLD_QUERY}.*3 sources`),
		);
		await expect(
			list.getByRole("menuitem", { name: "Search the web…" }),
		).toBeVisible();
		// The file name the chat keeps for the reader's own screen is nowhere in the menu.
		await expect(list).not.toContainText("private-name");
		// Neither kind has a row of its own before the chat's.
		await expect(page.getByTestId("canvas-insert-photo")).toHaveCount(0);
		await expect(page.getByTestId("canvas-insert-liveweb")).toHaveCount(0);
	});

	test("puts a photo search on the board as a grid of the app's own thumbnails, and it is still there after a reload", async ({
		page,
	}) => {
		await stubThumbnails(page);
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);

		await pickFromChat(page, /beach/);

		await expect(nodeOf(page, "photo")).toHaveCount(1);
		const thumbs = page.getByTestId("canvas-photo-thumb");
		await expect(thumbs).toHaveCount(6);
		// Six of the eight are drawn, and the last says how many more there are.
		await expect(page.getByTestId("canvas-photo")).toContainText("+2");
		const sources = await page
			.getByTestId("canvas-photo")
			.locator("img")
			.evaluateAll((images) =>
				images.map((image) => (image as HTMLImageElement).getAttribute("src")),
			);
		expect(sources).toHaveLength(6);
		for (const src of sources)
			expect(src).toMatch(/^\/api\/connections\/immich\/thumbnail\/asset-b\d$/);
		// They really loaded: a stand-in for the library answered with pictures.
		await expect
			.poll(async () =>
				page
					.getByTestId("canvas-photo")
					.locator("img")
					.evaluateAll((images) =>
						images.every(
							(image) => (image as HTMLImageElement).naturalWidth > 0,
						),
					),
			)
			.toBe(true);

		await savedStatus(page);
		const stored = await storedBoard(seeded.boardId);
		const photo = stored.nodes.find((node) => node.type === "photo");
		expect(photo?.data).toMatchObject({ kind: "photo" });
		const items = (
			photo?.data as { items: { id: string; imageUrl: string; alt?: string }[] }
		).items;
		expect(items.map((item) => item.id)).toEqual(BEACH);
		for (const item of items) {
			expect(item.imageUrl).toBe(`${PROXY}${item.id}`);
			// Nothing of the chat's own words about the photo went into the board.
			expect(item).not.toHaveProperty("alt");
		}
		expect(JSON.stringify(stored)).not.toContain("private-name");

		await page.reload({ waitUntil: "networkidle" });
		await openBoard(page);
		await expect(nodeOf(page, "photo")).toHaveCount(1);
		await expect(page.getByTestId("canvas-photo-thumb")).toHaveCount(6);
	});

	test("opens a thumbnail in the chat's lightbox over the page, pages through every photo, leaves the board alone, and gives focus back to the thumbnail", async ({
		page,
	}) => {
		await stubThumbnails(page);
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await pickFromChat(page, /beach/);
		await expect(page.getByTestId("canvas-photo-thumb")).toHaveCount(6);
		const boxOf = () =>
			page
				.locator(
					'.svelte-flow__node:has([data-testid="canvas-node"][data-kind="photo"])',
				)
				.boundingBox();
		const before = await boxOf();

		const opener = page.getByTestId("canvas-photo-thumb").nth(1);
		await opener.click();

		const dialog = page.getByRole("dialog", { name: "Image viewer" });
		await expect(dialog).toBeVisible();
		await expect(page.getByTestId("image-lightbox-counter")).toHaveText(
			"2 / 8",
		);
		await expect(dialog.locator("img")).toHaveAttribute(
			"src",
			`${PROXY}asset-b2`,
		);
		// Over the page: the topmost thing at its centre is the viewer's own.
		await expect
			.poll(async () =>
				dialog.evaluate((element) => {
					const rect = element.getBoundingClientRect();
					const top = document.elementFromPoint(
						rect.left + rect.width / 2,
						rect.top + rect.height / 2,
					);
					return top !== null && element.contains(top);
				}),
			)
			.toBe(true);
		// Focus went into the viewer, so the arrow keys are its own.
		await expect(dialog).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowRight");
		await expect(page.getByTestId("image-lightbox-counter")).toHaveText(
			"4 / 8",
		);
		await expect(dialog.locator("img")).toHaveAttribute(
			"src",
			`${PROXY}asset-b4`,
		);
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByTestId("image-lightbox-counter")).toHaveText(
			"3 / 8",
		);
		// The keys that paged the viewer did not move the block behind it.
		expect(await boxOf()).toEqual(before);

		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(opener).toBeFocused();
		expect(await boxOf()).toEqual(before);

		// Opened again and closed by its own button: focus comes back the same way.
		await page.getByTestId("canvas-photo-thumb").nth(4).click();
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Close" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByTestId("canvas-photo-thumb").nth(4)).toBeFocused();
	});

	test("shows a quiet empty tile for a photo that will not load, keeps the others, and leaves it out of the viewer", async ({
		page,
	}) => {
		await stubThumbnails(page, ["asset-b3"]);
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await pickFromChat(page, /beach/);

		const missing = page.getByTestId("canvas-photo-missing");
		await expect(missing).toHaveCount(1);
		await expect(missing).toHaveAccessibleName("Photo not available");
		await expect(page.getByTestId("canvas-photo-thumb")).toHaveCount(5);

		// The block and the board carry on: the fourth photo is the third one the viewer can show.
		await page.getByTestId("canvas-photo-thumb").nth(2).click();
		await expect(page.getByTestId("image-lightbox-counter")).toHaveText(
			"3 / 7",
		);
		await expect(
			page.getByRole("dialog", { name: "Image viewer" }).locator("img"),
		).toHaveAttribute("src", `${PROXY}asset-b4`);
	});

	test("never asks for a picture from outside the app, whatever a stored board holds: a block with such an address is left out, the rest of the board is not", async ({
		page,
	}) => {
		await stubThumbnails(page);
		const requested: string[] = [];
		page.on("request", (request) => requested.push(request.url()));
		const hostile = [
			"https://evil.example/pixel.png?d=secret",
			"//evil.example/pixel.png",
			"/\\evil.example/pixel.png",
			"/\t/evil.example/pixel.png",
			"/api/auth/logout",
		];
		const board = emptyCanvasBody();
		board.nodes = [
			{
				id: "photo-ok",
				type: "photo",
				position: { x: 0, y: 0 },
				data: {
					kind: "photo",
					items: [{ id: "ok", imageUrl: `${PROXY}asset-ok?connectionId=c1` }],
				},
			},
			...hostile.map((imageUrl, index) => ({
				id: `photo-bad-${index}`,
				type: "photo" as const,
				position: { x: 400, y: index * 260 },
				data: { kind: "photo" as const, items: [{ id: "bad", imageUrl }] },
			})),
		];
		const seeded = await seedChat(page, { body: board });
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);

		await expect(nodeOf(page, "photo")).toHaveCount(1);
		await expect(page.getByTestId("canvas-photo-thumb")).toHaveCount(1);
		await expect(page.getByTestId("canvas-dropped-notice")).toContainText(
			`${hostile.length} block(s)`,
		);
		const sources = await page
			.locator("img")
			.evaluateAll((images) =>
				images.map(
					(image) => (image as HTMLImageElement).getAttribute("src") ?? "",
				),
			);
		expect(sources.join(" ")).not.toContain("evil.example");
		expect(requested.filter((url) => url.includes("evil.example"))).toEqual([]);
		expect(requested.filter((url) => url.includes("/api/auth/logout"))).toEqual(
			[],
		);
		// The address the board does keep is the proxy's own.
		await expect(
			page.getByTestId("canvas-photo").locator("img"),
		).toHaveAttribute("src", `${PROXY}asset-ok?connectionId=c1`);
	});

	test("lists an incognito chat's photo and web searches only to that chat", async ({
		page,
	}) => {
		const normal = await seedChat(page, { tag: "-normal" });
		const incognito = await seedChat(page, { tag: "-incog", incognito: true });
		const list = async (boardId: string, conversationId?: string) => {
			const query = conversationId
				? `?conversationId=${encodeURIComponent(conversationId)}`
				: "";
			return page.request.get(`/api/artifacts/${boardId}/chat-blocks${query}`);
		};

		// The incognito board answers only a read that names its own chat.
		expect((await list(incognito.boardId)).status()).toBe(404);
		expect(
			(await list(incognito.boardId, normal.conversationId)).status(),
		).toBe(404);
		const own = await list(incognito.boardId, incognito.conversationId);
		expect(own.status()).toBe(200);
		const ownBody = await own.json();
		expect(ownBody.photos).toHaveLength(2);
		expect(ownBody.searches).toHaveLength(2);
		expect(JSON.stringify(ownBody)).toContain("-incog");
		expect(JSON.stringify(ownBody)).not.toContain("-normal");

		// The normal chat's board lists its own work and none of the incognito chat's.
		const other = await (await list(normal.boardId)).json();
		expect(other.photos).toHaveLength(2);
		expect(other.searches).toHaveLength(2);
		expect(JSON.stringify(other)).toContain("-normal");
		expect(JSON.stringify(other)).not.toContain("-incog");
	});

	test("puts a web search on the board: its query, its sources as links that open in a new tab, and how old the snapshot is", async ({
		page,
	}) => {
		await page.context().route("https://weather1.example.com/**", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<title>Source one</title><p>Source one</p>",
			}),
		);
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);

		await pickFromChat(page, new RegExp(FRESH_QUERY));

		const node = nodeOf(page, "liveweb");
		await expect(node).toHaveCount(1);
		await expect(node).toContainText(FRESH_QUERY);
		const sources = page.getByTestId("canvas-liveweb-source");
		await expect(sources).toHaveCount(4);
		const first = sources.first();
		await expect(first).toHaveAttribute(
			"href",
			"https://weather1.example.com/cork",
		);
		await expect(first).toHaveAttribute("target", "_blank");
		await expect(first).toHaveAttribute("rel", "noopener noreferrer");
		await expect(first).toContainText("Forecast source 1");
		await expect(first).toContainText("weather1.example.com");
		await expect(page.getByTestId("canvas-liveweb-age")).toHaveText(
			/Updated (just now|\d+ min ago)/,
		);
		await expect(page.getByTestId("canvas-liveweb-stale")).toHaveCount(0);
		// A site's icon comes from the app's own favicon proxy, never from the site.
		await expect(
			page.getByTestId("canvas-liveweb").locator(".web__favicon img").first(),
		).toHaveAttribute("src", "/api/favicon?domain=weather1.example.com");

		// The link opens the page in a tab of its own that has no way back to the board.
		const [popup] = await Promise.all([
			page.context().waitForEvent("page"),
			first.click(),
		]);
		await popup.waitForLoadState();
		expect(popup.url()).toBe("https://weather1.example.com/cork");
		expect(await popup.evaluate(() => window.opener)).toBeNull();
		await popup.close();

		await savedStatus(page);
		const stored = await storedBoard(seeded.boardId);
		const web = stored.nodes.find((n) => n.type === "liveweb");
		const data = web?.data as LiveWebData;
		expect(data.query).toBe(FRESH_QUERY);
		expect(data.sources).toHaveLength(4);
		expect(data.sources[0]).toMatchObject({
			url: "https://weather1.example.com/cork",
			provider: "parallel",
		});
		// The snapshot is as old as the chat's search was, not as old as the insert.
		expect(data.fetchedAt).toBeGreaterThan(Date.now() - 6 * 60_000);
		expect(data.fetchedAt).toBeLessThan(Date.now() - 4 * 60_000);
	});

	test("calls a search from hours ago not live, and says how long ago", async ({
		page,
	}) => {
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);

		await pickFromChat(page, new RegExp(OLD_QUERY));

		await expect(nodeOf(page, "liveweb")).toHaveCount(1);
		await expect(page.getByTestId("canvas-liveweb-stale")).toHaveText(
			"Not live",
		);
		await expect(page.getByTestId("canvas-liveweb-age")).toHaveText(
			/Updated 3 h ago/,
		);
	});

	test("refreshes a block: the request names only the block, the new sources replace the old on the board, and the board saves them as the reader's own version that Undo can take back", async ({
		page,
	}) => {
		const sent = await stubRefresh(page, (nodeId) => ({
			status: 200,
			body: { ok: true, nodeId, data: freshSnapshot(OLD_QUERY) },
		}));
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await pickFromChat(page, new RegExp(OLD_QUERY));
		await expect(page.getByTestId("canvas-liveweb-stale")).toHaveText(
			"Not live",
		);
		await savedStatus(page);
		const versionsBefore = await versionRows(seeded.boardId);
		const nodeId = (await storedBoard(seeded.boardId)).nodes.find(
			(n) => n.type === "liveweb",
		)?.id as string;

		await page.getByRole("button", { name: "Refresh" }).click();

		await expect(
			page.getByTestId("canvas-liveweb-source").first(),
		).toContainText("Brand new result 1");
		await expect(page.getByTestId("canvas-liveweb-source")).toHaveCount(3);
		await expect(page.getByTestId("canvas-liveweb-age")).toHaveText(
			/Updated just now/,
		);
		await expect(page.getByTestId("canvas-liveweb-stale")).toHaveCount(0);
		await expect(page.getByTestId("canvas-liveweb-status")).toHaveText("");

		// One bare POST to the block's own address: no body, no content type, no query string.
		expect(sent).toHaveLength(1);
		expect(sent[0].method).toBe("POST");
		expect(new URL(sent[0].url).pathname).toBe(
			`/api/artifacts/${seeded.boardId}/blocks/${nodeId}/refresh`,
		);
		expect(new URL(sent[0].url).search).toBe(
			`?conversationId=${seeded.conversationId}`,
		);
		expect(sent[0].body).toBeNull();
		expect(sent[0].contentType).toBeUndefined();
		expect(sent[0].url).not.toContain(OLD_QUERY.split(" ")[0]);

		// The board's own save keeps it, as the reader's version.
		await savedStatus(page);
		const stored = await storedBoard(seeded.boardId);
		const data = stored.nodes.find((n) => n.id === nodeId)?.data as LiveWebData;
		expect(data.query).toBe(OLD_QUERY);
		expect(data.sources.map((source) => source.title)).toEqual([
			"Brand new result 1",
			"Brand new result 2",
			"Brand new result 3",
		]);
		const versions = await versionRows(seeded.boardId);
		expect(versions.length).toBeGreaterThanOrEqual(versionsBefore.length);
		expect(versions.slice(1).every((row) => row.author === "user")).toBe(true);
		expect(versions.at(-1)?.author).toBe("user");

		// It is a step of the reader's own: Undo brings the old snapshot back, and saves it.
		await page.getByTestId("canvas-undo").click();
		await expect(page.getByTestId("canvas-liveweb-stale")).toHaveText(
			"Not live",
		);
		await expect(page.getByTestId("canvas-liveweb-source")).toHaveCount(3);
		await expect(
			page.getByTestId("canvas-liveweb-source").first(),
		).toContainText("Forecast source 1");
	});

	test("leaves the snapshot exactly as it was when a refresh fails, says so, saves nothing, and works on the next try", async ({
		page,
	}) => {
		let attempt = 0;
		await stubRefresh(page, (nodeId) => {
			attempt += 1;
			if (attempt === 1) {
				return { status: 422, body: { ok: false, reason: "refresh_failed" } };
			}
			return {
				status: 200,
				body: { ok: true, nodeId, data: freshSnapshot(OLD_QUERY) },
			};
		});
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await pickFromChat(page, new RegExp(OLD_QUERY));
		await savedStatus(page);
		const storedBefore = JSON.stringify(await storedBoard(seeded.boardId));
		const versionsBefore = await versionRows(seeded.boardId);

		await page.getByRole("button", { name: "Refresh" }).click();

		await expect(page.getByTestId("canvas-liveweb-status")).toHaveText(
			"Could not refresh this block.",
		);
		await expect(
			page.getByTestId("canvas-liveweb-source").first(),
		).toContainText("Forecast source 1");
		await expect(page.getByTestId("canvas-liveweb-stale")).toHaveText(
			"Not live",
		);
		await page.waitForTimeout(1_500);
		expect(JSON.stringify(await storedBoard(seeded.boardId))).toBe(
			storedBefore,
		);
		expect(await versionRows(seeded.boardId)).toEqual(versionsBefore);
		// The button is back and works.
		await page.getByRole("button", { name: "Refresh" }).click();
		await expect(
			page.getByTestId("canvas-liveweb-source").first(),
		).toContainText("Brand new result 1");
		await expect(page.getByTestId("canvas-liveweb-status")).toHaveText("");
	});

	test("says when the reader has searched too often, or the search found nothing, without touching the block", async ({
		page,
	}) => {
		const answers = [
			{ status: 429, body: { ok: false, reason: "rate_limited" } },
			{ status: 422, body: { ok: false, reason: "no_results" } },
		];
		let index = 0;
		await stubRefresh(page, () => answers[index++] ?? answers[1]);
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await pickFromChat(page, new RegExp(OLD_QUERY));

		await page.getByRole("button", { name: "Refresh" }).click();
		await expect(page.getByTestId("canvas-liveweb-status")).toHaveText(
			"Too many searches at once. Try again in a moment.",
		);
		await page.getByRole("button", { name: "Refresh" }).click();
		await expect(page.getByTestId("canvas-liveweb-status")).toHaveText(
			"The search found nothing new to show.",
		);
		await expect(
			page.getByTestId("canvas-liveweb-source").first(),
		).toContainText("Forecast source 1");
	});

	test("is refreshed by the keyboard alone: the button is in the tab order, named, and stays focused while it works", async ({
		page,
	}) => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/api/artifacts/*/blocks/*/refresh*", async (route) => {
			await gate;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					nodeId: decodeURIComponent(
						new URL(route.request().url()).pathname.split("/").slice(-2)[0] ??
							"",
					),
					data: freshSnapshot(OLD_QUERY),
				}),
			});
		});
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await pickFromChat(page, new RegExp(OLD_QUERY));

		const button = page.getByRole("button", { name: "Refresh" });
		await button.focus();
		await page.keyboard.press("Enter");

		const busy = page.getByRole("button", { name: "Refreshing…" });
		await expect(busy).toBeVisible();
		await expect(busy).toHaveAttribute("aria-busy", "true");
		await expect(busy).toHaveAttribute("aria-disabled", "true");
		await expect(busy).toBeFocused();
		// A second press while it works does not start a second search.
		await page.keyboard.press("Enter");
		release();
		await expect(
			page.getByTestId("canvas-liveweb-source").first(),
		).toContainText("Brand new result 1");
		await expect(page.getByRole("button", { name: "Refresh" })).toBeFocused();
	});

	test("searches the web from the Insert menu: the query goes in the body, the block lands with what came back, and a failure keeps what was typed", async ({
		page,
	}) => {
		const sent = await stubSearch(page, (query) =>
			query === "will fail"
				? { status: 422, body: { ok: false, reason: "refresh_failed" } }
				: { status: 200, body: { ok: true, data: freshSnapshot(query) } },
		);
		const seeded = await seedChat(page);
		await openChatAndReload(page, seeded.conversationId);
		await openBoard(page);
		await openInsertMenu(page);

		await menu(page).getByRole("menuitem", { name: "Search the web…" }).click();
		const field = menu(page).getByRole("textbox", { name: "Search the web" });
		await expect(field).toBeFocused();
		// The menu's own keys are the field's: the cursor moves in what is typed.
		await field.fill("will fail");
		await page.keyboard.press("Home");
		await page.keyboard.press("ArrowRight");
		await expect(field).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(menu(page).getByRole("status")).toHaveText(
			"The search did not work. Try again.",
		);
		await expect(field).toHaveValue("will fail");
		await expect(field).toBeFocused();
		await expect(nodeOf(page, "liveweb")).toHaveCount(0);

		await field.fill("  bratislava weather  ");
		await page.keyboard.press("Enter");

		await expect(menu(page)).toHaveCount(0);
		await expect(nodeOf(page, "liveweb")).toHaveCount(1);
		await expect(nodeOf(page, "liveweb")).toContainText("bratislava weather");
		await expect(page.getByTestId("canvas-liveweb-source")).toHaveCount(3);
		await expect(page.getByTestId("canvas-liveweb-age")).toHaveText(
			/Updated just now/,
		);
		await savedStatus(page);
		const stored = await storedBoard(seeded.boardId);
		expect(
			(stored.nodes.find((n) => n.type === "liveweb")?.data as LiveWebData)
				.query,
		).toBe("bratislava weather");
		// What was asked travelled in the body, never in the address.
		expect(sent).toHaveLength(2);
		for (const request of sent) {
			expect(request.method).toBe("POST");
			expect(new URL(request.url).pathname).toBe(
				`/api/artifacts/${seeded.boardId}/blocks/liveweb`,
			);
			expect(request.url).not.toMatch(/bratislava|fail/);
		}
		expect(JSON.parse(sent[1].body ?? "{}")).toEqual({
			query: "bratislava weather",
		});
	});

	test("the real routes refuse before any search is made: unknown board, a block that is not a live-web block, a query that is not a query, a body that is too large, no session", async ({
		page,
		request,
		playwright,
	}) => {
		const board = emptyCanvasBody();
		board.nodes = [
			{
				id: "note-1",
				type: "sticky",
				position: { x: 0, y: 0 },
				data: { kind: "sticky", text: "Lunch", tone: "yellow" },
			},
			{
				id: "map-1",
				type: "map",
				position: { x: 300, y: 0 },
				data: {
					kind: "map",
					route: "Cork → Kinsale",
					map: {
						bounds: { minLat: 51.7, minLng: -8.5, maxLat: 51.9, maxLng: -8.4 },
						attribution: "© OpenStreetMap contributors",
					},
				},
			},
		];
		const seeded = await seedChat(page, { body: board });
		const post = (
			path: string,
			options?: { data?: unknown; headers?: Record<string, string> },
		) => page.request.post(path, options);

		const missing = await post(
			"/api/artifacts/no-such-board/blocks/note-1/refresh",
		);
		expect(missing.status()).toBe(404);
		expect(await missing.json()).toEqual({ ok: false, reason: "not_found" });
		const missingSearch = await post(
			"/api/artifacts/no-such-board/blocks/liveweb",
			{
				data: { query: "weather" },
			},
		);
		expect(missingSearch.status()).toBe(404);
		expect(await missingSearch.text()).toBe(await missing.text());

		for (const nodeId of ["note-1", "map-1"]) {
			const refused = await post(
				`/api/artifacts/${seeded.boardId}/blocks/${nodeId}/refresh`,
			);
			expect(refused.status(), nodeId).toBe(422);
			expect(await refused.json()).toEqual({
				ok: false,
				reason: "not_refreshable",
			});
		}
		const noSuchBlock = await post(
			`/api/artifacts/${seeded.boardId}/blocks/nope/refresh`,
		);
		expect(noSuchBlock.status()).toBe(404);

		for (const data of [
			{ query: "" },
			{ query: "   " },
			{ query: "a\nb" },
			{ query: 42 },
			{},
		]) {
			const refused = await post(
				`/api/artifacts/${seeded.boardId}/blocks/liveweb`,
				{ data },
			);
			expect(refused.status(), JSON.stringify(data)).toBe(400);
			expect(await refused.json()).toEqual({
				ok: false,
				reason: "invalid_query",
			});
		}
		const tooLarge = await post(
			`/api/artifacts/${seeded.boardId}/blocks/liveweb`,
			{
				data: { query: "x".repeat(6_000) },
			},
		);
		expect(tooLarge.status()).toBe(413);

		// No session: 401 at the HTTP layer, for both.
		const anonymous = await playwright.request.newContext({
			baseURL: test.info().project.use.baseURL,
		});
		for (const path of [
			`/api/artifacts/${seeded.boardId}/blocks/note-1/refresh`,
			`/api/artifacts/${seeded.boardId}/blocks/liveweb`,
		]) {
			const refused = await anonymous.post(path, {
				data: { query: "weather" },
			});
			expect(refused.status(), path).toBe(401);
		}
		await anonymous.dispose();
		void request;
	});
});
