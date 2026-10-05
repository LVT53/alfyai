import { randomUUID } from "node:crypto";
import {
	type APIRequestContext,
	expect,
	type Locator,
	type Page,
} from "@playwright/test";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	announcementCampaigns,
	artifacts,
	artifactTourStates,
	artifactVersions,
	chatGeneratedFiles,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import { createDocumentArtifact } from "../../src/lib/server/services/artifacts";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import type { ShippedArtifactTourType } from "../../src/lib/shared/artifacts/tours";
import { createConversation, login } from "./helpers";

// What the first-open tours' specs share. The e2e admin (the one user every
// other spec signs in as) was marked as having seen every tour by
// global-setup, so no other spec ever meets a card: a tour needs a user who
// has not seen it, and each test here makes its own, which is also what makes
// "a second user still sees it" something the suite can say without a reset
// route the app does not have.

export type TourKind = ShippedArtifactTourType;
export type TourUser = { id: string; email: string; password: string };

/** The title each seeded item carries, so a row can be found by what the reader sees. */
export const ITEM_TITLES: Record<TourKind, string> = {
	document: "Trip notes",
	app: "Tip calculator",
	canvas: "Weekend board",
};

export function isMobile(page: Page): boolean {
	return (page.viewportSize()?.width ?? 1440) < 768;
}

/** A user who has seen nothing: a fresh row, a password only this test knows. */
export async function createTourUser(
	language: "en" | "hu" = "en",
): Promise<TourUser> {
	const id = randomUUID();
	const suffix = id.slice(0, 8);
	const user = {
		id,
		email: `tour-${suffix}@local`,
		password: `tour-${suffix}-password`,
	};
	await db.insert(users).values({
		id,
		email: user.email,
		passwordHash: bcrypt.hashSync(user.password, 4),
		name: `Tour reader ${suffix}`,
		role: "user",
		uiLanguage: language,
	});
	return user;
}

/** Signs in as the user and starts a chat through the real composer. */
export async function startChatAs(page: Page, user: TourUser): Promise<string> {
	await login(page, user.email, user.password);
	return createConversation(page, "A chat for the tour");
}

const APP_HTML =
	'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tip calculator</title></head><body><h1>Tip calculator</h1><p data-testid="tour-app-ready">Ready</p></body></html>';

function emptyBoard(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "note-lunch",
				type: "sticky",
				position: { x: 80, y: 80 },
				width: 190,
				data: { kind: "sticky", text: "Lunch at the market", tone: "yellow" },
			},
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

/** One item of the kind, in the user's chat, seeded the way the other artifact specs seed theirs. */
export async function seedItem(
	user: TourUser,
	conversationId: string,
	kind: TourKind,
): Promise<string> {
	const title = ITEM_TITLES[kind];
	if (kind === "document") {
		const document = await createDocumentArtifact({
			userId: user.id,
			conversationId,
			title,
			markdown: "## Plan\n\nFriday: Naschmarkt, Secession.\n",
			author: "user",
			summary: "Seeded for E2E",
		});
		return document.id;
	}
	const body = kind === "app" ? APP_HTML : boardJson(emptyBoard());
	const artifactId = randomUUID();
	const now = new Date();
	await db.insert(artifacts).values({
		id: artifactId,
		userId: user.id,
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
		userId: user.id,
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy made it",
		body,
		bodyHash: "seed-hash",
		createdAt: now,
	});
	return artifactId;
}

/** A produced file (the File kind) in the user's chat: an assistant message, its file row, and the artifact row the panel lists it by. */
export async function seedProducedFile(
	user: TourUser,
	conversationId: string,
	filename = "Vienna trip summary.pdf",
): Promise<void> {
	const assistantMessageId = randomUUID();
	const chatFileId = randomUUID();
	await db.insert(messages).values({
		id: assistantMessageId,
		conversationId,
		role: "assistant",
		content: "Here is the summary.",
	});
	await db.insert(chatGeneratedFiles).values({
		id: chatFileId,
		conversationId,
		assistantMessageId,
		userId: user.id,
		filename,
		mimeType: "application/pdf",
		sizeBytes: 2048,
		storagePath: `test/${chatFileId}.pdf`,
	});
	await db.insert(artifacts).values({
		id: randomUUID(),
		userId: user.id,
		conversationId,
		type: "generated_output",
		retrievalClass: "ephemeral_followup",
		name: filename,
		mimeType: "application/pdf",
		metadataJson: JSON.stringify({ originalChatFileId: chatFileId }),
	});
}

/** A real reload of the chat, with the first-message flag cleared so the page loads the full conversation. */
export async function reopenChat(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

/** The panel's own surface for the viewport: the docked panel, or the phone's overlay. */
export function panelShell(page: Page): Locator {
	return isMobile(page)
		? page.getByTestId("document-workspace-mobile-shell")
		: page.locator("aside.workspace-shell-desktop");
}

export function panelList(page: Page): Locator {
	return page.getByTestId(
		isMobile(page) ? "artifact-panel-list-mobile" : "artifact-panel-list",
	);
}

/** Opens the chat's list through the header count button, unless it is already showing. */
export async function openPanelList(page: Page) {
	const list = panelList(page);
	if (await list.isVisible()) return;
	await page
		.getByTestId(
			isMobile(page)
				? "artifact-count-button-compact"
				: "artifact-count-button",
		)
		.click();
	await expect(list).toBeVisible({ timeout: 15_000 });
}

/** Opens the item named `title` from the list, with a click on its row. */
export async function openItem(page: Page, title: string) {
	await openPanelList(page);
	await panelList(page)
		.getByTestId("artifact-row")
		.filter({ hasText: title })
		.click({ timeout: 30_000 });
}

/** The header's breadcrumb: from an open item back to the list. */
export async function backToList(page: Page) {
	await panelShell(page)
		.getByRole("button", { name: /^Back to This chat/ })
		.click();
	await expect(panelList(page)).toBeVisible();
}

export function tourCard(page: Page): Locator {
	return page.getByTestId("artifact-tour");
}

/** The tour requests the page makes, so "no request at all" and "nothing written" are things a test can say. */
export function watchTourRequests(page: Page) {
	const seen: { method: string; url: string }[] = [];
	page.on("request", (request) => {
		// The pathname, not a substring: the dev server also serves the client
		// module `/src/lib/client/api/artifact-tours.ts`.
		const { pathname } = new URL(request.url());
		if (pathname.startsWith("/api/artifact-tours")) {
			seen.push({ method: request.method(), url: pathname });
		}
	});
	return {
		all: () => [...seen],
		gets: () => seen.filter((entry) => entry.method === "GET"),
		posts: () => seen.filter((entry) => entry.method === "POST"),
	};
}

/** What the user's tour state looks like in the database right now. */
export async function tourRows(userId: string) {
	return db
		.select({
			artifactType: artifactTourStates.artifactType,
			contentKey: artifactTourStates.contentKey,
			status: artifactTourStates.status,
			slideCount: artifactTourStates.slideCount,
			lastSlide: artifactTourStates.lastSlide,
			updatedAt: artifactTourStates.updatedAt,
		})
		.from(artifactTourStates)
		.where(eq(artifactTourStates.userId, userId));
}

/** The panel asked for the tour of `kind` and was answered: after this an absent card is an answer, not a race. */
export function waitForTourAnswer(page: Page, kind: TourKind) {
	return page.waitForResponse(
		(response) =>
			response.request().method() === "GET" &&
			new URL(response.url()).pathname === `/api/artifact-tours/${kind}`,
	);
}

/** Real clicks through the card: Next until the last slide, then "Got it". */
export async function finishTour(page: Page) {
	const card = tourCard(page);
	await expect(card).toBeVisible({ timeout: 20_000 });
	await card.getByTestId("artifact-tour-next").click();
	await card.getByTestId("artifact-tour-next").click();
	await card.getByTestId("artifact-tour-done").click();
	await expect(card).toHaveCount(0);
}

// ---- Publishing as an admin, the way an admin does (the version badge and the 409) ----

export async function adminApi(
	request: APIRequestContext,
): Promise<APIRequestContext> {
	const response = await request.post("/api/auth/login", {
		data: { email: "admin@local", password: "admin123" },
	});
	expect(response.ok(), "the e2e admin must sign in").toBe(true);
	return request;
}

/** Seeds the tour drafts, publishes the newest draft of `kind`, and returns the campaign id (to archive afterwards). */
export async function publishTour(
	api: APIRequestContext,
	kind: TourKind,
): Promise<string> {
	const seeded = await api.post("/api/admin/campaigns/seed-artifact-tours");
	expect(seeded.ok(), "seeding the tour drafts").toBe(true);
	const listed = await api.get("/api/admin/campaigns");
	expect(listed.ok()).toBe(true);
	const { campaigns } = (await listed.json()) as {
		campaigns: {
			id: string;
			type: string;
			status: string;
			releaseVersion: string | null;
		}[];
	};
	const draft = campaigns.find(
		(campaign) =>
			campaign.type === "artifact_tour" &&
			campaign.releaseVersion === kind &&
			campaign.status === "draft",
	);
	expect(draft, `a ${kind} tour draft to publish`).toBeTruthy();
	const published = await api.post(
		`/api/admin/campaigns/${(draft as { id: string }).id}/publish`,
	);
	expect(published.ok(), "publishing the tour").toBe(true);
	return (draft as { id: string }).id;
}

/**
 * Takes a published tour back out, by deleting its campaign (the snapshot, its
 * slides and every reader's state of it go with it: the tables cascade).
 * Archiving would be wrong here: an archived tour is a deliberate retirement
 * (ruling 4), after which the kind has NO tour at all, and the e2e database
 * outlives this spec. Deleting returns the kind to its code copy, as the run
 * found it.
 */
export async function removeTour(campaignId: string) {
	await db
		.delete(announcementCampaigns)
		.where(eq(announcementCampaigns.id, campaignId));
}
