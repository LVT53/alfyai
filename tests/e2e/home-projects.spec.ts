import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	conversations,
	messages,
	projects,
	users,
} from "../../src/lib/server/db/schema";
import { login, waitForHydration } from "./helpers";

/**
 * The home projects row (Workspaces Slice G, mockup §M6): up to three cards
 * for the projects that have been active lately, between the composer and
 * Recent.
 *
 * A card is a way back into something the user made — so the row is judged
 * here on three things: which projects reach it, what each card says about
 * them, and where a click lands.
 *
 * Projects are created through the real API, files through the real upload and
 * link routes, and chats inserted as rows (the same split project-page.spec.ts
 * uses: the services run a sequence-repair statement better-sqlite3 refuses
 * inside the Playwright runner). The figures on a card are all already in the
 * database before the home screen is ever loaded — nothing here asks a turn to
 * produce them.
 */

const UPLOAD_RAW_PATH = "/api/knowledge/upload/raw";

function nameOf(label: string): string {
	// Unique per test, so a leftover row from another spec cannot satisfy an
	// assertion about this one's card.
	return `${label} ${randomUUID().slice(0, 8)}`;
}

async function adminUserId(): Promise<string> {
	const [admin] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();
	return admin.id;
}

/**
 * Departs from an empty board: the row is built from the projects the admin
 * has chats in, so both halves of that — the chats and the projects — have to
 * go, whichever spec put them there.
 */
async function clearProjectFixtures(userId: string): Promise<void> {
	await db.delete(conversations).where(eq(conversations.userId, userId));
	await db.delete(projects).where(eq(projects.userId, userId));
}

async function createProject(page: Page, name: string): Promise<string> {
	const response = await page.request.post("/api/projects", { data: { name } });
	expect(response.ok(), "creating a project must succeed").toBe(true);
	const project = (await response.json()) as { id: string };
	return project.id;
}

async function saveInstructions(
	page: Page,
	projectId: string,
	instructions: string,
): Promise<void> {
	const response = await page.request.patch(`/api/projects/${projectId}`, {
		data: { instructions },
	});
	expect(response.ok(), "saving instructions must succeed").toBe(true);
}

/**
 * A chat in the project, with one message in it. `listRecentlyActiveProjects`
 * counts conversations that have carried a message — the message is what makes
 * the row eligible at all, so it is not decoration.
 */
async function seedChat(options: {
	projectId: string;
	title: string;
	updatedAt: Date;
}): Promise<string> {
	const userId = await adminUserId();
	const id = randomUUID();
	await db.insert(conversations).values({
		id,
		userId,
		title: options.title,
		projectId: options.projectId,
		createdAt: options.updatedAt,
		updatedAt: options.updatedAt,
	});
	await db.insert(messages).values({
		id: `${id}-msg-1`,
		conversationId: id,
		messageSequence: 1,
		role: "user" as const,
		content: `${options.title}: where do I start?`,
		createdAt: options.updatedAt,
	});
	return id;
}

/** A chat that has never been typed into: drafted, not started. */
async function seedDraftChat(projectId: string): Promise<string> {
	const userId = await adminUserId();
	const id = randomUUID();
	await db.insert(conversations).values({
		id,
		userId,
		title: "New chat",
		projectId,
	});
	return id;
}

async function uploadLibraryDocument(
	page: Page,
	name: string,
): Promise<string> {
	const body = `Notes for ${name}\n`;
	const response = await page.request.post(UPLOAD_RAW_PATH, {
		headers: {
			"content-type": "text/plain",
			"x-alfyai-upload-name": encodeURIComponent(name),
			"x-alfyai-upload-size": String(Buffer.byteLength(body, "utf8")),
			"x-alfyai-upload-trace-id": `e2e-${randomUUID()}`,
		},
		data: body,
	});
	expect(response.ok(), `uploading ${name} must succeed`).toBe(true);
	const payload = (await response.json()) as { artifact: { id: string } };
	return payload.artifact.id;
}

async function linkArtifacts(
	page: Page,
	projectId: string,
	artifactIds: string[],
): Promise<void> {
	const response = await page.request.post(
		`/api/projects/${projectId}/knowledge`,
		{ data: { artifactIds } },
	);
	expect(response.ok(), "linking must succeed").toBe(true);
}

function hoursAgo(hours: number): Date {
	return new Date(Date.now() - hours * 60 * 60 * 1000);
}

async function gotoHome(page: Page) {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 15000,
	});
	// The card row only renders once the summary has landed.
	await page.getByTestId("home-board").waitFor({ timeout: 15000 });
}

test.describe("home projects row", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
	});

	test("draws a card per recently active project, newest first", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearProjectFixtures(userId);

		// Newest of all, and the only project carrying every figure a card can
		// show: two chats, instructions, and a file.
		const icelandName = nameOf("Iceland trip");
		const iceland = await createProject(page, icelandName);
		await saveInstructions(page, iceland, "Prefer trains over flights.");
		await seedChat({
			projectId: iceland,
			title: "Reykjavik in October",
			updatedAt: hoursAgo(2),
		});
		await seedChat({
			projectId: iceland,
			title: "The golden circle by car",
			updatedAt: hoursAgo(2),
		});
		const notes = await uploadLibraryDocument(
			page,
			`Flight notes ${randomUUID().slice(0, 6)}.txt`,
		);
		await linkArtifacts(page, iceland, [notes]);

		// One chat, nothing else — the card that must show no indicator row.
		const kitchenName = nameOf("Kitchen renovation");
		const kitchen = await createProject(page, kitchenName);
		await seedChat({
			projectId: kitchen,
			title: "Worktop quotes",
			updatedAt: hoursAgo(5),
		});

		const oldestName = nameOf("Garden plans");
		const garden = await createProject(page, oldestName);
		await seedChat({
			projectId: garden,
			title: "Where the beds go",
			updatedAt: hoursAgo(26),
		});

		await gotoHome(page);

		const cards = page.getByTestId("home-project-card");
		await expect(cards).toHaveCount(3);
		await expect(page.getByTestId("home-projects-heading")).toHaveText(
			"Projects",
		);

		// Order is the row's whole argument: newest activity first.
		await expect(cards.nth(0)).toHaveAttribute("href", `/projects/${iceland}`);
		await expect(cards.nth(1)).toHaveAttribute("href", `/projects/${kitchen}`);
		await expect(cards.nth(2)).toHaveAttribute("href", `/projects/${garden}`);

		await expect(cards.nth(0)).toContainText(icelandName);
		await expect(cards.nth(0).getByTestId("home-project-stats")).toHaveText(
			"2 chats · active 2 hours ago",
		);
		await expect(
			cards.nth(0).getByTestId("home-project-instructions"),
		).toHaveText("Instructions");
		await expect(cards.nth(0).getByTestId("home-project-files")).toHaveText(
			"1 file",
		);
		// The accessible name is the action, not the card's text run together.
		await expect(cards.nth(0)).toHaveAttribute(
			"aria-label",
			`Open ${icelandName}`,
		);

		await expect(cards.nth(1)).toContainText(kitchenName);
		// One chat reads as "1 chat", not "1 chats".
		await expect(cards.nth(1).getByTestId("home-project-stats")).toHaveText(
			"1 chat · active 5 hours ago",
		);
		// No instructions, no files: no indicator row at all, rather than a row
		// saying zero.
		await expect(
			cards.nth(1).getByTestId("home-project-instructions"),
		).toHaveCount(0);
		await expect(cards.nth(1).getByTestId("home-project-files")).toHaveCount(0);

		await expect(cards.nth(2)).toContainText(oldestName);
		await expect(cards.nth(2).getByTestId("home-project-stats")).toHaveText(
			"1 chat · active yesterday",
		);
	});

	test("gives a project with no chats no card", async ({ page }) => {
		// Decision 9: an empty project is not "recently active". The rule is
		// `listRecentlyActiveProjects`' and the client does not re-apply it —
		// so this asserts the rule's *effect*, on a screen, from the outside.
		const userId = await adminUserId();
		await clearProjectFixtures(userId);

		const busyName = nameOf("Busy project");
		const busy = await createProject(page, busyName);
		await seedChat({
			projectId: busy,
			title: "Something real",
			updatedAt: hoursAgo(3),
		});

		const emptyName = nameOf("Empty folder");
		await createProject(page, emptyName);

		const draftName = nameOf("Draft only");
		const draft = await createProject(page, draftName);
		await seedDraftChat(draft);

		await gotoHome(page);

		const row = page.getByTestId("home-projects");
		await expect(page.getByTestId("home-project-card")).toHaveCount(1);
		await expect(page.getByTestId("home-project-card").first()).toContainText(
			busyName,
		);
		// Absent, not greyed out and not a zero: nothing on the board names them.
		await expect(row).not.toContainText(emptyName);
		await expect(row).not.toContainText(draftName);
	});

	test("shows three cards at most, and leaves the least recent project out", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearProjectFixtures(userId);

		const names = ["First", "Second", "Third", "Fourth"];
		const ids: string[] = [];
		for (const [index, label] of names.entries()) {
			const name = nameOf(label);
			const id = await createProject(page, name);
			await seedChat({
				projectId: id,
				title: `${label} chat`,
				updatedAt: hoursAgo(index + 1),
			});
			ids.push(id);
		}

		await gotoHome(page);

		const cards = page.getByTestId("home-project-card");
		await expect(cards).toHaveCount(3);
		// The oldest of the four is the one that does not fit.
		await expect(cards.nth(0)).toHaveAttribute("href", `/projects/${ids[0]}`);
		await expect(cards.nth(2)).toHaveAttribute("href", `/projects/${ids[2]}`);
		await expect(page.getByTestId("home-projects")).not.toContainText(
			names[3] as string,
		);
	});

	test("takes the click through to the project it names", async ({ page }) => {
		const userId = await adminUserId();
		await clearProjectFixtures(userId);

		const projectName = nameOf("Iceland trip");
		const project = await createProject(page, projectName);
		await seedChat({
			projectId: project,
			title: "Reykjavik in October",
			updatedAt: hoursAgo(1),
		});

		await gotoHome(page);
		// An anchor, but a click that arrives before hydration lands on inert
		// markup in this app's shell — see `waitForHydration`.
		await waitForHydration(page);
		await page.getByTestId("home-project-card").first().click();

		await expect(page).toHaveURL(new RegExp(`/projects/${project}$`));
		await expect(page.getByTestId("project-greeting")).toHaveText(projectName);
	});

	test("leaves the row, heading and all, off the board when there is nothing to show", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearProjectFixtures(userId);
		// A project exists and has simply never been used — the row has nothing
		// to say, and says nothing rather than drawing an empty shelf.
		await createProject(page, nameOf("Nothing has happened here"));

		await gotoHome(page);

		await expect(page.getByTestId("home-projects")).toHaveCount(0);
		await expect(page.getByTestId("home-projects-heading")).toHaveCount(0);
		await expect(page.getByTestId("home-project-card")).toHaveCount(0);
		// And the rest of the board still drew — this row is not load-bearing.
		await expect(page.getByTestId("home-greeting")).toBeVisible();
		await expect(page.getByTestId("message-input")).toBeVisible();
	});

	test("scrolls the cards sideways on a phone instead of stacking them into Recent", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearProjectFixtures(userId);

		for (const [index, label] of ["One", "Two", "Three"].entries()) {
			const id = await createProject(page, nameOf(label));
			await seedChat({
				projectId: id,
				title: `${label} chat`,
				updatedAt: hoursAgo(index + 1),
			});
		}

		await page.setViewportSize({ width: 390, height: 844 });
		await gotoHome(page);

		const layout = await page
			.locator(".home-projects-grid")
			.evaluate((node) => {
				const style = getComputedStyle(node);
				return { display: style.display, overflowX: style.overflowX };
			});
		expect(layout).toEqual({ display: "flex", overflowX: "auto" });

		// One row, not three stacked: the cards share a top edge.
		const boxes = await page
			.getByTestId("home-project-card")
			.evaluateAll((nodes) =>
				nodes.map((node) => {
					const rect = node.getBoundingClientRect();
					return { y: rect.y, width: rect.width, height: rect.height };
				}),
			);
		expect(boxes).toHaveLength(3);
		for (const box of boxes) {
			expect(box.y).toBeCloseTo(boxes[0]?.y ?? 0, 1);
			expect(box.width).toBeCloseTo(150, 0);
		}

		// And the row did not push the composer off the screen.
		await expect(page.getByTestId("message-input")).toBeInViewport();
	});
});
