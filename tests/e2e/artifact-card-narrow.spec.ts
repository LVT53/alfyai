import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	chatGeneratedFiles,
	conversations,
	fileProductionJobFiles,
	fileProductionJobs,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import {
	applyDocumentPatch,
	createDocumentArtifact,
	readDocumentForAlfy,
} from "../../src/lib/server/services/artifacts";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import { createConversation, login, waitForStableBoundingBox } from "./helpers";

// FX-D: the in-chat card at a docked panel's narrow chat column. With the panel
// docked the chat column is ~340 px at a 1100 px window and the card used to
// break its meta line into four ("Dokumentum / · 1 fül / · / v1") while "Megnyitva
// a panelen ›" was drawn over it. The card now adapts to ITS OWN width (a
// container query on the card, not the viewport): when it is narrow the action
// takes a row of its own under the text, the meta line stays one line (it
// ends in an ellipsis before it wraps) and nothing overlaps.
//
// Seeded the way FX-C's meta-line spec seeds its card (the artifact rows and
// the message carrying the call's own record: the layout does not depend on how
// the item came to be); the panel is docked by a REAL click on the first card,
// Hungarian (the longest labels: "Megnyitva a panelen", "Újragenerálás"), and
// what is measured is where the browser drew each part.
//
// FXD_SHOTS=<dir> also writes the screenshots the fix is judged by.

const WIDTHS = [1100, 1280, 1440] as const;

type Box = {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
};

type CardGeometry = {
	card: Box;
	title: Box | null;
	/** The column the title and the meta line share (the title's own box is only as wide as its words). */
	textColumn: Box | null;
	/** How tall the facts line is, in lines of its own text (1 is one line). */
	factsLines: number | null;
	/** Every box the head's meta text is drawn in (the pills left out), before any clipping. */
	metaBoxes: Box[];
	/** The same, cut to what is not clipped away (the card's own edge, or the line's ellipsis box). */
	metaVisible: Box[];
	pills: Box[];
	/** The action: "Megnyitás ›" / "Megnyitva a panelen ›" / "Átnézés ›" / "Újragenerálás". */
	action: Box | null;
	/** What its words alone cover (the box has padding around them). */
	actionWords: Box | null;
};

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

let nextSequence = 900;

/** The message a create_artifact call leaves: the call's own record names the item the card is for. */
async function seedCallMessage(
	conversationId: string,
	made: {
		id: string;
		kind: "document" | "app" | "canvas";
		title: string;
		/** What the call kept of its arguments (the default is a whole request). */
		input?: Record<string, unknown>;
	},
): Promise<void> {
	nextSequence += 1;
	await db.insert(messages).values({
		id: randomUUID(),
		conversationId,
		messageSequence: nextSequence,
		role: "assistant",
		content: `Made ${made.title}.`,
		toolCalls: JSON.stringify([
			{
				type: "tool_call",
				callId: `e2e-narrow-${nextSequence}`,
				name: "create_artifact",
				input: made.input ?? {
					artifactType: made.kind,
					title: made.title,
					body: `# ${made.title}`,
				},
				status: "done",
				outputSummary: `Created ${made.title}`,
				sourceType: "tool",
				metadata: {
					ok: true,
					artifactId: made.id,
					artifactKind: made.kind,
					artifactTitle: made.title,
				},
			},
		]),
		createdAt: new Date(Date.now() + nextSequence),
	});
}

async function seedRow(
	conversationId: string,
	kind: "app" | "canvas",
	title: string,
	body: string,
): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const now = new Date();
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: title,
		contentText: body,
		metadataJson: JSON.stringify({ artifactType: kind, title }),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(artifactVersions).values({
		id: randomUUID(),
		artifactId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy wrote the first draft",
		body,
		bodyHash: "seed-hash",
		createdAt: now,
	});
	return artifactId;
}

const TITLES = {
	reviewed: "Weekend plan",
	pending: "Packing list",
	canvas: "Weekend board",
	app: "Budget app",
	deleted: "Old itinerary",
	unavailable: "Lost itinerary",
	unreachable: "Trip notes",
	file: "Trip summary",
} as const;

/**
 * One chat with the five cards the layout has to read for: a reviewed Document
 * (the first: the click that docks the panel), a Document with a change to
 * review, a board, an App, and a Document that was deleted.
 */
async function seedChat(page: Page): Promise<string> {
	const userId = await testUserId();
	// An item of an incognito chat of the same reader: it exists, and the chat
	// below cannot reach it (incognito hides a chat's work from the reader's
	// OTHER chats), so its card says where it was made.
	const otherConversationId = await createConversation(page, "Plan a trip");
	await db
		.update(conversations)
		.set({ memoryIncognito: true })
		.where(eq(conversations.id, otherConversationId));
	const foreign = await createDocumentArtifact({
		userId,
		conversationId: otherConversationId,
		title: TITLES.unreachable,
		markdown: "# Trip notes\n\nPack light.",
		author: "alfy",
		summary: "Alfy wrote the first draft",
	});
	await page.goto("/");
	await page
		.getByTestId("message-input")
		.waitFor({ state: "visible", timeout: 60_000 });
	const conversationId = await createConversation(page, "Plan a weekend");

	const reviewed = await createDocumentArtifact({
		userId,
		conversationId,
		title: TITLES.reviewed,
		markdown: "# Weekend plan\n\nBook the museum tickets.",
		author: "alfy",
		summary: "Alfy wrote the first draft",
	});
	await seedCallMessage(conversationId, {
		id: reviewed.id,
		kind: "document",
		title: TITLES.reviewed,
	});

	const pending = await createDocumentArtifact({
		userId,
		conversationId,
		title: TITLES.pending,
		markdown: "# Packing list\n\nPassport.\n\nCharger.",
		author: "user",
		summary: "Seeded for E2E",
	});
	const read = await readDocumentForAlfy({
		userId,
		artifactId: pending.id,
		conversationId,
	});
	const target = read.blocks[1];
	const edited = await applyDocumentPatch({
		userId,
		artifactId: pending.id,
		conversationId,
		patch: {
			patchId: "card-narrow-e2e-patch",
			label: "Alfy edit",
			ops: [
				{
					opId: "card-narrow-e2e-op",
					kind: "replaceBlock" as const,
					blockId: target.blockId,
					baseHash: target.hash,
					blockLabel: target.label,
					text: `${target.text} (and the adapter)`,
				},
			],
		},
	});
	expect(edited.ok, "the seed patch must apply").toBe(true);
	await seedCallMessage(conversationId, {
		id: pending.id,
		kind: "document",
		title: TITLES.pending,
	});

	const board: CanvasBody = {
		version: 1,
		nodes: [
			{
				id: "note-a",
				type: "sticky",
				position: { x: 40, y: 40 },
				width: 190,
				data: { kind: "sticky", text: "Lunch at the market", tone: "yellow" },
			},
			{
				id: "note-b",
				type: "sticky",
				position: { x: 280, y: 40 },
				width: 190,
				data: { kind: "sticky", text: "Museum at ten", tone: "blue" },
			},
			{
				id: "text-c",
				type: "text",
				position: { x: 40, y: 220 },
				width: 240,
				data: { kind: "text", text: "Weekend plan" },
			},
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
	const canvasId = await seedRow(
		conversationId,
		"canvas",
		TITLES.canvas,
		boardJson(board),
	);
	await seedCallMessage(conversationId, {
		id: canvasId,
		kind: "canvas",
		title: TITLES.canvas,
	});

	const appId = await seedRow(
		conversationId,
		"app",
		TITLES.app,
		"<!doctype html><title>Budget</title><p>Hello</p>",
	);
	await seedCallMessage(conversationId, {
		id: appId,
		kind: "app",
		title: TITLES.app,
	});

	// Never made: the id names nothing, so the card says it was deleted.
	await seedCallMessage(conversationId, {
		id: randomUUID(),
		kind: "document",
		title: TITLES.deleted,
	});

	// Deleted, and the call kept no usable request: Regenerate will say it cannot.
	await seedCallMessage(conversationId, {
		id: randomUUID(),
		kind: "document",
		title: TITLES.unavailable,
		input: { artifactType: "document" },
	});

	// Made in another chat: the item exists, out of this chat's reach.
	await seedCallMessage(conversationId, {
		id: foreign.id,
		kind: "document",
		title: TITLES.unreachable,
	});

	// A produced file: what the pipeline leaves (the chat file, the artifact that
	// stands for it and the succeeded job that made it), whose row is the File
	// kind's `chrome="body"` card under the message.
	nextSequence += 1;
	const fileMessageId = randomUUID();
	const chatFileId = randomUUID();
	const jobId = randomUUID();
	const now = new Date(Date.now() + nextSequence);
	await db.insert(messages).values({
		id: fileMessageId,
		conversationId,
		role: "assistant",
		content: "Here is the trip summary.",
		messageSequence: nextSequence,
		createdAt: now,
	});
	await db.insert(chatGeneratedFiles).values({
		id: chatFileId,
		conversationId,
		assistantMessageId: fileMessageId,
		userId,
		filename: "Trip summary.md",
		mimeType: "text/markdown",
		sizeBytes: 20,
		storagePath: `${conversationId}/${chatFileId}.md`,
		createdAt: now,
	});
	await db.insert(artifacts).values({
		id: randomUUID(),
		userId,
		conversationId,
		type: "generated_output",
		retrievalClass: "durable",
		name: "Trip summary.md",
		mimeType: "text/markdown",
		contentText: "Generated file: Trip summary.md",
		metadataJson: JSON.stringify({
			generatedFile: true,
			originalChatFileId: chatFileId,
			generatedFilename: "Trip summary.md",
			documentLabel: "Trip summary.md",
			versionNumber: 1,
		}),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(fileProductionJobs).values({
		id: jobId,
		conversationId,
		assistantMessageId: fileMessageId,
		userId,
		title: TITLES.file,
		status: "succeeded",
		origin: "produce_file",
		requestJson: JSON.stringify({
			sourceMode: "inline_text",
			outputs: [],
			documentIntent: null,
			templateHint: null,
			program: null,
			documentSource: null,
			inlineText: null,
		}),
		sourceMode: "inline_text",
		createdAt: now,
		updatedAt: now,
		completedAt: now,
	});
	await db.insert(fileProductionJobFiles).values({
		id: randomUUID(),
		jobId,
		chatGeneratedFileId: chatFileId,
		sortOrder: 0,
		createdAt: now,
	});
	return conversationId;
}

async function readGeometry(card: Locator): Promise<CardGeometry> {
	return card.evaluate((root) => {
		const toBox = (rect: DOMRect | DOMRectReadOnly) => ({
			left: rect.left,
			top: rect.top,
			right: rect.right,
			bottom: rect.bottom,
			width: rect.width,
			height: rect.height,
		});
		const one = (selector: string) => root.querySelector<HTMLElement>(selector);
		const cardBox = root.getBoundingClientRect();

		// Where the meta text is drawn: every text node of the head's second line
		// that is not inside a pill, as the browser laid it out.
		const metaBoxes: ReturnType<typeof toBox>[] = [];
		const metaVisible: ReturnType<typeof toBox>[] = [];
		const sub = one(".artifact-card-sub");
		if (sub) {
			const walker = document.createTreeWalker(sub, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (!node.textContent?.trim()) continue;
				const parent = node.parentElement as HTMLElement;
				if (parent.closest(".pill")) continue;
				const range = document.createRange();
				range.selectNodeContents(node);
				// What an ancestor that clips (overflow) lets through, up to the card.
				let clipRight = Number.POSITIVE_INFINITY;
				for (
					let el: HTMLElement | null = parent;
					el;
					el = el === root ? null : el.parentElement
				) {
					if (getComputedStyle(el).overflowX !== "visible") {
						clipRight = Math.min(clipRight, el.getBoundingClientRect().right);
					}
				}
				for (const rect of Array.from(range.getClientRects())) {
					metaBoxes.push(toBox(rect));
					const right = Math.min(rect.right, clipRight);
					if (right > rect.left) {
						metaVisible.push(
							toBox(
								new DOMRect(
									rect.left,
									rect.top,
									right - rect.left,
									rect.height,
								),
							),
						);
					}
				}
			}
		}

		const action = one(".artifact-card-cta, .artifact-card-regenerate");
		let actionWords: ReturnType<typeof toBox> | null = null;
		if (action) {
			const range = document.createRange();
			range.selectNodeContents(action);
			actionWords = toBox(range.getBoundingClientRect());
		}
		const title = one(".artifact-card-title");
		const textColumn = one(".artifact-card-headtext");
		const facts = one(".artifact-card-facts");
		return {
			// The height of the line in units of its own font: a second line would
			// double it.
			factsLines: facts
				? facts.getBoundingClientRect().height /
					Number.parseFloat(getComputedStyle(facts).fontSize) /
					1.2
				: null,
			card: toBox(cardBox),
			title: title ? toBox(title.getBoundingClientRect()) : null,
			textColumn: textColumn ? toBox(textColumn.getBoundingClientRect()) : null,
			metaBoxes,
			metaVisible,
			pills: Array.from(root.querySelectorAll<HTMLElement>(".pill")).map(
				(pill) => toBox(pill.getBoundingClientRect()),
			),
			action: action ? toBox(action.getBoundingClientRect()) : null,
			actionWords,
		};
	});
}

function overlap(a: Box, b: Box): boolean {
	const slop = 0.5;
	return (
		a.left < b.right - slop &&
		b.left < a.right - slop &&
		a.top < b.bottom - slop &&
		b.top < a.bottom - slop
	);
}

/** How many lines the meta text is drawn on. */
function lineCount(geometry: CardGeometry): number {
	return new Set(geometry.metaBoxes.map((box) => Math.round(box.top))).size;
}

function card(page: Page, title: string): Locator {
	return page.getByTestId("artifact-card").filter({ hasText: title });
}

/** One line of numbers per card, for the run's log when the shots are taken (every failed claim carries its own numbers). */
function report(title: string, label: string, geometry: CardGeometry): void {
	if (!process.env.FXD_SHOTS) return;
	const px = (box: Box | null) =>
		box
			? `${Math.round(box.left)}..${Math.round(box.right)} x ${Math.round(box.top)}..${Math.round(box.bottom)}`
			: "none";
	console.log(
		`[card-narrow] ${label} · ${title}: card ${Math.round(geometry.card.width)} px, title ${px(geometry.title)}, meta lines ${lineCount(geometry)}, meta ${geometry.metaBoxes.map(px).join(" | ")}, pills ${geometry.pills.map(px).join(" | ") || "none"}, action ${px(geometry.action)}`,
	);
}

/** The things on a card an action must not be drawn over. */
function thingsBesideTheAction(geometry: CardGeometry): Box[] {
	return [
		...(geometry.title ? [geometry.title] : []),
		...geometry.metaVisible,
		...geometry.pills,
	];
}

async function useHungarian(): Promise<void> {
	await db
		.update(users)
		.set({ uiLanguage: "hu" })
		.where(eq(users.email, "admin@local"));
}

async function useEnglish(): Promise<void> {
	await db
		.update(users)
		.set({ uiLanguage: "en" })
		.where(eq(users.email, "admin@local"));
}

/** What the specs read off the page in each language. */
type Words = {
	document: string;
	threeBlocks: string;
	/** The sentence a card says when Regenerate was tried and cannot work. */
	cannotRegenerate: RegExp;
};
const HUNGARIAN: Words = {
	document: "Dokumentum",
	threeBlocks: "3 blokk",
	cannotRegenerate: /Nem generálható újra/,
};
const ENGLISH: Words = {
	document: "Document",
	threeBlocks: "3 blocks",
	cannotRegenerate: /It can't be regenerated/,
};

/**
 * What a settled chat shows. The pills arrive after the cards: the persisted
 * count of the pending Document with the conversation detail, and the reviewed
 * Document's "Átnézve" only once the panel has opened it (the open body reports
 * its review state), so a card measured earlier is measured twice. The one
 * Regenerate that cannot work is pressed with a real click, so its card says why.
 */
async function waitForTheCardsToSettle(
	page: Page,
	words: Words,
	options: { panelOpen: boolean } = { panelOpen: true },
): Promise<void> {
	if (options.panelOpen) {
		await expect(card(page, TITLES.reviewed).locator(".pill")).toHaveCount(1);
	}
	await expect(card(page, TITLES.pending).locator(".pill")).toHaveCount(1);
	await expect(card(page, TITLES.canvas)).toContainText(words.threeBlocks);
	await expect(
		card(page, TITLES.deleted).getByTestId("artifact-card-regenerate"),
	).toBeVisible();
	await expect(card(page, TITLES.unreachable)).toHaveAttribute(
		"data-state",
		"unreachable",
	);
	const lost = card(page, TITLES.unavailable);
	await lost.getByTestId("artifact-card-regenerate").click();
	await expect(lost).toContainText(words.cannotRegenerate);
	await waitForStableBoundingBox(card(page, TITLES.reviewed));
}

/** Docks the panel with a real click on the first card and waits for the layout to settle. */
async function dockThePanel(page: Page, words: Words): Promise<void> {
	await card(page, TITLES.reviewed).getByTestId("artifact-card-head").click();
	await expect(
		page.getByRole("complementary", {
			name: new RegExp(`${TITLES.reviewed}, ${words.document}$`),
		}),
	).toBeVisible({ timeout: 30_000 });
	await waitForStableBoundingBox(card(page, TITLES.reviewed));
}

/** The shots, light then dark, of whatever the page shows now (a tall window, so every card is in view). */
async function shootBothSchemes(page: Page, name: string): Promise<void> {
	const dir = process.env.FXD_SHOTS;
	if (!dir) return;
	const size = page.viewportSize() ?? { width: 1280, height: 800 };
	await page.setViewportSize({ width: size.width, height: 3000 });
	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await page.waitForTimeout(250);
		await page.screenshot({ path: `${dir}/${name}-${scheme}.png` });
	}
	await page.emulateMedia({ colorScheme: "light" });
	await page.setViewportSize(size);
}

/**
 * What every card must satisfy wherever its action is: its text keeps a column,
 * all of it is inside the card, and nothing is drawn over anything else. A card
 * with an action also draws that inside the card and over none of the text.
 */
function expectTheCardReads(
	geometry: CardGeometry,
	where: string,
	minColumn = 150,
): void {
	const column = geometry.textColumn as Box;
	expect
		.soft(
			column.width,
			`${where}: the title and the meta line keep a column of their own`,
		)
		.toBeGreaterThanOrEqual(minColumn);
	for (const box of geometry.metaVisible) {
		expect
			.soft(box.right, `${where}: the text is cut off at the right`)
			.toBeLessThanOrEqual(column.right + 0.5);
	}
	for (const pill of geometry.pills) {
		expect
			.soft(pill.right, `${where}: a pill runs past the text column`)
			.toBeLessThanOrEqual(column.right + 0.5);
	}

	const action = geometry.action;
	if (!action) return;
	for (const thing of thingsBesideTheAction(geometry)) {
		expect
			.soft(
				overlap(action, thing),
				`${where}: the action (${Math.round(action.left)}..${Math.round(action.right)} × ${Math.round(action.top)}..${Math.round(action.bottom)}) is drawn over something at ${Math.round(thing.left)}..${Math.round(thing.right)} × ${Math.round(thing.top)}..${Math.round(thing.bottom)}`,
			)
			.toBe(false);
	}
	expect
		.soft(action.right, `${where}: the action's right edge`)
		.toBeLessThanOrEqual(geometry.card.right + 0.5);
	expect
		.soft(action.left, `${where}: the action's left edge`)
		.toBeGreaterThanOrEqual(geometry.card.left - 0.5);
}

/** The meta text of a card is one line (a live card's kind, facts and version). */
function expectOneLine(geometry: CardGeometry, where: string): void {
	expect
		.soft(lineCount(geometry), `${where}: the lines the meta text is drawn on`)
		.toBe(1);
	// The brief's own measure: the line's height is one line's (a line of 12.5 px
	// text is ~15 px; a second line would make it 30).
	if (geometry.factsLines !== null) {
		expect
			.soft(
				geometry.factsLines,
				`${where}: the facts line's height in lines of its own text`,
			)
			.toBeLessThan(1.5);
	}
}

/** The lowest edge of what the card says (title, meta line, pills). */
function lowestText(geometry: CardGeometry): number {
	return Math.max(
		(geometry.title as Box).bottom,
		...geometry.metaVisible.map((box) => box.bottom),
		...geometry.pills.map((box) => box.bottom),
	);
}

/** A narrow card: the action is a row of its own, under the text. */
function expectTheActionOnItsOwnRow(
	geometry: CardGeometry,
	where: string,
	minColumn = 150,
): void {
	expect
		.soft(geometry.action, `${where}: the card has an action`)
		.not.toBeNull();
	expectTheCardReads(geometry, where, minColumn);
	expect
		.soft(
			(geometry.action as Box).top,
			`${where}: the action sits under the title and the meta line`,
		)
		.toBeGreaterThanOrEqual(lowestText(geometry) - 0.5);
}

/** A wide card: the action stays where it always was, beside the text. */
function expectTheActionBesideTheText(
	geometry: CardGeometry,
	where: string,
): void {
	expect
		.soft(geometry.action, `${where}: the card has an action`)
		.not.toBeNull();
	expectTheCardReads(geometry, where);
	const action = geometry.action as Box;
	expect
		.soft(
			action.top,
			`${where}: the action is on the row of the title, not under it`,
		)
		.toBeLessThan(lowestText(geometry));
	for (const thing of thingsBesideTheAction(geometry)) {
		expect
			.soft(
				action.left,
				`${where}: the action is to the right of everything the card says`,
			)
			.toBeGreaterThanOrEqual(thing.right - 0.5);
	}
}

/** Everything the File row draws stays inside the grey box that holds it (a row's own box bleeds a little for its hover). */
async function fileRowFits(page: Page): Promise<string[]> {
	return page
		.getByTestId("file-production-card")
		.first()
		.evaluate((root) => {
			const holder = root.closest("[data-testid=tool-activity-body]") ?? root;
			const box = holder.getBoundingClientRect();
			const out: string[] = [];
			for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
				if (rect.right > box.right + 1 || rect.left < box.left - 1) {
					out.push(
						`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${Math.round(rect.left)}..${Math.round(rect.right)} outside ${Math.round(box.left)}..${Math.round(box.right)}`,
					);
				}
			}
			return out;
		});
}

const LIVE_CARDS = [
	TITLES.reviewed,
	TITLES.pending,
	TITLES.canvas,
	TITLES.app,
] as const;

/** Every state of a card, measured the way its layout promises (narrow: the action under the text). */
async function expectEveryCardOnItsOwnRow(
	page: Page,
	label: string,
	minColumn = 150,
): Promise<void> {
	// Live cards: the reviewed Document (open in the panel), the one with a
	// change to review, the board, the App.
	for (const title of LIVE_CARDS) {
		const geometry = await readGeometry(card(page, title));
		report(title, label, geometry);
		const where = `"${title}" ${label} (card ${Math.round(geometry.card.width)} px wide)`;
		expectOneLine(geometry, where);
		expectTheActionOnItsOwnRow(geometry, where, minColumn);
	}

	// Deleted, with Regenerate: it sits under the sentence, over nothing.
	const gone = await readGeometry(card(page, TITLES.deleted));
	report(TITLES.deleted, label, gone);
	const goneWhere = `the deleted card ${label} (card ${Math.round(gone.card.width)} px wide)`;
	// A sentence, not a facts line: it fits one line in the columns a laptop's
	// panel leaves, and wraps (never cuts) in a tablet's.
	if (minColumn >= 150) expectOneLine(gone, goneWhere);
	expectTheActionOnItsOwnRow(gone, goneWhere, minColumn);

	// Deleted, and Regenerate said it cannot, and out of this chat's reach: a
	// sentence or two and no action; they may wrap, never run off the card.
	for (const title of [TITLES.unavailable, TITLES.unreachable]) {
		const geometry = await readGeometry(card(page, title));
		report(title, label, geometry);
		const where = `"${title}" ${label} (card ${Math.round(geometry.card.width)} px wide)`;
		expect.soft(geometry.action, `${where}: no action`).toBeNull();
		expectTheCardReads(geometry, where, minColumn);
	}
}

test.describe("the in-chat artifact card at a docked panel's narrow chat column", () => {
	test.afterEach(async () => {
		await useEnglish();
	});

	for (const width of WIDTHS) {
		test(`every card keeps its action on a row of its own and its meta line on one line (${width} px, panel docked, Hungarian)`, async ({
			page,
		}) => {
			await useHungarian();
			await page.setViewportSize({ width, height: 800 });
			await login(page);
			const conversationId = await seedChat(page);
			await openChatAndReload(page, conversationId);
			await dockThePanel(page, HUNGARIAN);
			await waitForTheCardsToSettle(page, HUNGARIAN);
			await shootBothSchemes(page, `docked-${width}-hu`);

			await expectEveryCardOnItsOwnRow(page, `at ${width} px`);

			// What a screen reader says is what the card shows, in the order it
			// shows it: the title, the kind and facts, the pill, then the action.
			await expect(
				card(page, TITLES.pending).getByTestId("artifact-card-head"),
			).toHaveAccessibleName(
				/Packing list.*Dokumentum · 1 fül.*v2.*1 módosítás vár rád.*Átnézés/,
			);

			// What a hover paints on the head and on the action's words (shots only).
			if (process.env.FXD_SHOTS && width === 1100) {
				const pending = card(page, TITLES.pending);
				await pending.getByTestId("artifact-card-head").hover();
				await pending.screenshot({
					path: `${process.env.FXD_SHOTS}/hover-pending-1100-hu-light.png`,
				});
			}

			// The File kind's row (`chrome="body"`) is its own layout: it must still
			// read in the same narrow column.
			expect
				.soft(await fileRowFits(page), `the File row at ${width} px`)
				.toEqual([]);
		});
	}

	test("a card in a wide column keeps its action beside the text (1440 px, panel closed, Hungarian)", async ({
		page,
	}) => {
		await useHungarian();
		await page.setViewportSize({ width: 1440, height: 800 });
		await login(page);
		const conversationId = await seedChat(page);
		await openChatAndReload(page, conversationId);
		await waitForTheCardsToSettle(page, HUNGARIAN, { panelOpen: false });
		await shootBothSchemes(page, "wide-1440-hu");

		for (const title of [TITLES.pending, TITLES.canvas, TITLES.app]) {
			const geometry = await readGeometry(card(page, title));
			const where = `"${title}" at 1440 px, panel closed (card ${Math.round(geometry.card.width)} px wide)`;
			expectOneLine(geometry, where);
			expectTheActionBesideTheText(geometry, where);
		}
		const gone = await readGeometry(card(page, TITLES.deleted));
		expectTheActionBesideTheText(
			gone,
			`the deleted card at 1440 px, panel closed (card ${Math.round(gone.card.width)} px wide)`,
		);
	});

	test("a phone's card is a narrow card too: its action has a row of its own and nothing is drawn over it (390 px, Hungarian)", async ({
		page,
	}) => {
		await useHungarian();
		await page.setViewportSize({ width: 390, height: 844 });
		await login(page);
		const conversationId = await seedChat(page);
		await openChatAndReload(page, conversationId);
		await waitForTheCardsToSettle(page, HUNGARIAN, { panelOpen: false });
		await shootBothSchemes(page, "phone-390-hu");

		await expectEveryCardOnItsOwnRow(page, "at 390 px");
		expect.soft(await fileRowFits(page), "the File row at 390 px").toEqual([]);
	});

	// A tablet (800 px) docks the panel too, and leaves the chat ~190 px for its
	// cards: narrower than their facts line and than a review pill. The line ends
	// in an ellipsis before it wraps, and the pill's words wrap inside the card
	// rather than run past its edge.
	test("a tablet's docked column cuts the facts line with an ellipsis and keeps the pills inside the card (800 px, Hungarian)", async ({
		page,
	}) => {
		await useHungarian();
		await page.setViewportSize({ width: 800, height: 1100 });
		await login(page);
		const conversationId = await seedChat(page);
		await openChatAndReload(page, conversationId);
		await dockThePanel(page, HUNGARIAN);
		await waitForTheCardsToSettle(page, HUNGARIAN);
		await shootBothSchemes(page, "docked-800-hu");
		if (process.env.FXD_SHOTS) {
			for (const [title, name] of [
				[TITLES.reviewed, "reviewed"],
				[TITLES.pending, "pending"],
				[TITLES.deleted, "deleted"],
			] as const) {
				await card(page, title).screenshot({
					path: `${process.env.FXD_SHOTS}/card-${name}-800-hu-light.png`,
				});
			}
		}

		await expectEveryCardOnItsOwnRow(page, "at 800 px", 100);

		const pending = card(page, TITLES.pending);
		const facts = pending.locator(".artifact-card-facts");
		const where = `"${TITLES.pending}" at 800 px`;
		expect(
			await facts.evaluate((element) => getComputedStyle(element).textOverflow),
			`${where}: what the line does when it does not fit`,
		).toBe("ellipsis");
		expect(
			await facts.evaluate(
				(element) => element.scrollWidth > element.clientWidth,
			),
			`${where}: the line is cut short, not wrapped`,
		).toBe(true);
	});

	test("English reads the same at the narrowest column (1100 px, panel docked)", async ({
		page,
	}) => {
		await useEnglish();
		await page.setViewportSize({ width: 1100, height: 800 });
		await login(page);
		const conversationId = await seedChat(page);
		await openChatAndReload(page, conversationId);
		await dockThePanel(page, ENGLISH);
		await waitForTheCardsToSettle(page, ENGLISH);
		await shootBothSchemes(page, "docked-1100-en");

		await expectEveryCardOnItsOwnRow(page, "at 1100 px in English");
	});
});
