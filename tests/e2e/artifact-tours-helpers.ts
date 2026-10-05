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

type AdminCampaign = {
	id: string;
	type: string;
	status: string;
	revision: number;
	releaseVersion: string | null;
};

/** Every `artifact_tour` campaign of `kind`, newest revision first. */
async function tourCampaigns(
	api: APIRequestContext,
	kind: TourKind,
): Promise<AdminCampaign[]> {
	const listed = await api.get("/api/admin/campaigns");
	expect(listed.ok()).toBe(true);
	const { campaigns } = (await listed.json()) as { campaigns: AdminCampaign[] };
	return campaigns
		.filter(
			(campaign) =>
				campaign.type === "artifact_tour" && campaign.releaseVersion === kind,
		)
		.sort((a, b) => b.revision - a.revision);
}

/**
 * Publishes a tour for `kind` the way an admin does, and returns the campaign
 * id (to archive afterwards). The seed leaves one draft per kind; when an
 * earlier test has published and archived it, there is none left, so the admin
 * duplicates the newest campaign of the kind, which is what the pane offers.
 * `summary` rewords the empty-state line before it goes out.
 */
export async function publishTour(
	api: APIRequestContext,
	kind: TourKind,
	options: { summary?: { en: string; hu: string } } = {},
): Promise<string> {
	const seeded = await api.post("/api/admin/campaigns/seed-artifact-tours");
	expect(seeded.ok(), "seeding the tour drafts").toBe(true);
	const campaigns = await tourCampaigns(api, kind);
	let draftId = campaigns.find((campaign) => campaign.status === "draft")?.id;
	if (!draftId) {
		const last = campaigns[0];
		expect(last, `a ${kind} tour campaign to duplicate`).toBeTruthy();
		const duplicated = await api.post(
			`/api/admin/campaigns/${last.id}/duplicate`,
		);
		expect(duplicated.status(), "duplicating the last tour").toBe(201);
		draftId = ((await duplicated.json()) as { campaign: { id: string } })
			.campaign.id;
	}
	if (options.summary) await rewordSummary(api, draftId, options.summary);
	const published = await api.post(`/api/admin/campaigns/${draftId}/publish`);
	expect(published.ok(), "publishing the tour").toBe(true);
	return draftId;
}

/** Changes the summary slide's title, which is the empty state's line, and keeps every other slide as it is. */
async function rewordSummary(
	api: APIRequestContext,
	campaignId: string,
	summary: { en: string; hu: string },
) {
	const got = await api.get(`/api/admin/campaigns/${campaignId}`);
	expect(got.ok()).toBe(true);
	const { campaign } = (await got.json()) as {
		campaign: { slides: { layoutType: string; title: unknown }[] };
	};
	const slides = campaign.slides.map((slide) =>
		slide.layoutType === "summary" ? { ...slide, title: summary } : slide,
	);
	const patched = await api.patch(`/api/admin/campaigns/${campaignId}`, {
		data: { slides },
	});
	expect(patched.ok(), "rewording the summary").toBe(true);
}

/**
 * Takes a published tour back out, as an admin does: archives it. Ruling 71:
 * the kind then shows its code copy again, which is how the run found it, so
 * no later spec on this database meets a tour nobody has seen.
 */
export async function archiveTour(api: APIRequestContext, campaignId: string) {
	const archived = await api.post(`/api/admin/campaigns/${campaignId}/archive`);
	expect(archived.ok(), "archiving the tour").toBe(true);
}
