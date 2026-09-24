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
import {
	ensureSidebarExpanded,
	login,
	sendMessage,
	waitForHydration,
} from "./helpers";

/**
 * The project page (Workspaces Slice D, mockup §M1) — the home page in project
 * mode, and the one place a chat can be started inside a project.
 *
 * Projects are created through the real API (the page's own subject is what
 * happens *after* one exists); chats are inserted as rows, like every other
 * spec that needs a listed conversation, because the services run a
 * sequence-repair statement better-sqlite3 refuses inside the runner.
 */

async function createProject(page: Page, name: string): Promise<string> {
	const response = await page.request.post("/api/projects", {
		data: { name },
	});
	expect(response.ok(), "creating a project must succeed").toBe(true);
	const project = (await response.json()) as { id: string };
	return project.id;
}

async function adminUserId(): Promise<string> {
	const [admin] = await db
		.select()
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();
	return admin.id;
}

/**
 * A chat with one message in it: the project page lists chats that have
 * carried a message, so an empty conversation would not show up.
 */
async function seedChat(options: {
	projectId: string | null;
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
		content: `${options.title}: what should I look at first?`,
		createdAt: options.updatedAt,
	});
	return id;
}

function hoursAgo(hours: number): Date {
	return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function projectRow(page: Page, name: string) {
	return page.getByTestId("project-drop-target").filter({ hasText: name });
}

async function openProjectPage(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}`, {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByTestId("project-greeting")).toBeVisible({
		timeout: 15000,
	});
	// The greeting is server-rendered, so it is visible before the page can be
	// clicked: the quiet line and the incognito arm are in the HTML either way,
	// but until hydration lands, a click on them goes nowhere (see
	// `waitForHydration`).
	await waitForHydration(page);
}

test.describe("Project page", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
	});

	test("opens from the sidebar hover button and from the New chat menu item", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);

		await page.goto("/", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await ensureSidebarExpanded(page);

		const row = projectRow(page, projectName);
		await row.hover();
		await row.getByRole("button", { name: `Open ${projectName}` }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
		await expect(page.getByTestId("project-greeting")).toHaveText(projectName);

		// The menu item is the second door into the same room, and it lands the
		// caret in the composer — the menu item's whole point is "start typing
		// here", which is only true if the box it opens is focused.
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await ensureSidebarExpanded(page);
		const secondRow = projectRow(page, projectName);
		await secondRow.getByRole("button", { name: "Project options" }).click();
		await page
			.getByRole("menuitem", { name: `Create chat in ${projectName}` })
			.click();

		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
		await expect(page.getByTestId("message-input")).toBeFocused();
	});

	test("shows the project name as the greeting and the project's chats below", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		await seedChat({
			projectId,
			title: "Train options Budapest to Vienna",
			updatedAt: hoursAgo(3),
		});
		await seedChat({
			projectId,
			title: "Museums open on Sunday",
			updatedAt: hoursAgo(26),
		});

		await openProjectPage(page, projectId);

		await expect(page.getByTestId("project-greeting")).toHaveText(projectName);
		// Decision 14: the line counts the project's chats and dates them by the
		// newest chat's activity, not by the newest message.
		await expect(page.getByTestId("project-stats")).toContainText("2 chats");
		await expect(page.getByTestId("project-stats")).toContainText("active");
		await expect(page.getByTestId("home-list-heading")).toHaveText(
			"2 chats in this project",
		);
		await expect(
			page.getByTestId("home-recent-line").filter({
				hasText: "Train options Budapest to Vienna",
			}),
		).toBeVisible();
		await expect(
			page.getByTestId("home-recent-line").filter({
				hasText: "Museums open on Sunday",
			}),
		).toBeVisible();

		// The listing is scoped: another chat outside the project must not ride
		// along on the project's page.
		const looseTitle = `Loose chat ${randomUUID().slice(0, 8)}`;
		await seedChat({
			projectId: null,
			title: looseTitle,
			updatedAt: hoursAgo(1),
		});
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("project-greeting")).toBeVisible();
		await expect(page.getByText(looseTitle)).toHaveCount(0);
	});

	test("creates the first chat inside the project when a message is sent from the project page", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);

		await openProjectPage(page, projectId);
		await sendMessage(page, "Which train should I take?");
		await page.waitForURL(/\/chat\//, { timeout: 20000 });

		const chatId = page.url().match(/\/chat\/([^/?#]+)/)?.[1] ?? "";
		expect(chatId, "the send must land on a chat page").not.toBe("");
		const [row] = await db
			.select({ projectId: conversations.projectId })
			.from(conversations)
			.where(eq(conversations.id, chatId))
			.limit(1);
		expect(row, `conversation ${chatId} must exist`).toBeTruthy();
		expect(row.projectId).toBe(projectId);
	});

	test("shows the empty list line for a project with no chats", async ({
		page,
	}) => {
		const projectName = `Empty trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);

		await openProjectPage(page, projectId);

		await expect(page.getByTestId("home-empty-line")).toHaveText(
			"No chats yet. The first message you send here starts one.",
		);
		await expect(page.getByTestId("home-list-heading")).toHaveCount(0);
		await expect(page.getByTestId("project-stats")).toContainText(
			"0 chats · active",
		);
	});

	/** The landing draft's conversation id, as the session carries it. */
	async function draftConversationId(page: Page): Promise<string | null> {
		return page.evaluate(() =>
			window.sessionStorage.getItem("landing-draft-conversation-id"),
		);
	}

	async function seedDraftOnLanding(page: Page, text: string) {
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await page.getByTestId("message-input").fill(text);
		// Typing is what prepares the conversation, so the test cannot go on
		// until the session carries one: without it the rest of the test would
		// silently exercise the ordinary "no draft at all" path instead.
		await expect.poll(() => draftConversationId(page)).not.toBeNull();
		return (await draftConversationId(page)) as string;
	}

	test("sends the first message into the project even when the home page had already prepared a draft", async ({
		page,
	}) => {
		// A draft typed on the home page belongs to no project. Reusing that
		// conversation from the project page would put the first message in a
		// chat the project does not own — the folder's instructions would not
		// reach the turn, and the commit that built this page promised the
		// opposite.
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const landingDraftId = await seedDraftOnLanding(page, "Hotel ideas?");

		await ensureSidebarExpanded(page);
		const row = projectRow(page, projectName);
		await row.hover();
		await row.getByRole("button", { name: `Open ${projectName}` }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
		await waitForHydration(page);

		await sendMessage(page, "Which train should I take?");
		await page.waitForURL(/\/chat\//, { timeout: 20000 });

		const chatId = page.url().match(/\/chat\/([^/?#]+)/)?.[1] ?? "";
		const [row2] = await db
			.select({ projectId: conversations.projectId })
			.from(conversations)
			.where(eq(conversations.id, chatId))
			.limit(1);
		expect(row2, `conversation ${chatId} must exist`).toBeTruthy();
		expect(
			row2.projectId,
			`the chat ${chatId} must belong to the project (home-page draft was ${landingDraftId})`,
		).toBe(projectId);
	});

	test("sends the first message outside the project when a project page had prepared the draft", async ({
		page,
	}) => {
		// The mirror: a draft prepared on a project's page belongs to that
		// project, so the home page must not adopt it — a chat started from the
		// home page would otherwise land inside somebody's folder.
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);

		await openProjectPage(page, projectId);
		await page.getByTestId("message-input").fill("Trains only, please.");
		await expect.poll(() => draftConversationId(page)).not.toBeNull();
		const projectDraftId = (await draftConversationId(page)) as string;

		await page.goto("/", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await sendMessage(page, "Something else entirely.");
		await page.waitForURL(/\/chat\//, { timeout: 20000 });

		const chatId = page.url().match(/\/chat\/([^/?#]+)/)?.[1] ?? "";
		const [row] = await db
			.select({ projectId: conversations.projectId })
			.from(conversations)
			.where(eq(conversations.id, chatId))
			.limit(1);
		expect(row, `conversation ${chatId} must exist`).toBeTruthy();
		expect(
			row.projectId,
			`the chat ${chatId} must not be inside the project (project-page draft was ${projectDraftId})`,
		).toBeNull();
	});

	test("keeps a prepared draft out of the project the composer moved away from", async ({
		page,
	}) => {
		// `/projects/[projectId]` is one route, so the sidebar's door to another
		// project is a client-side navigation that reuses the page component:
		// everything the first page's surface held in `$state` is still there on
		// the second. The draft it prepared belongs to the project the user just
		// left, and the composer on this page says it starts a chat in the one now
		// on screen — so the first message must land in the second project, not in
		// the folder the user walked away from.
		const first = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const second = `Lisbon trip ${randomUUID().slice(0, 8)}`;
		const firstId = await createProject(page, first);
		const secondId = await createProject(page, second);

		await openProjectPage(page, firstId);
		await page.getByTestId("message-input").fill("Trains to Vienna.");
		await expect.poll(() => draftConversationId(page)).not.toBeNull();
		const firstDraftId = (await draftConversationId(page)) as string;
		const [draftRow] = await db
			.select({ projectId: conversations.projectId })
			.from(conversations)
			.where(eq(conversations.id, firstDraftId))
			.limit(1);
		expect(
			draftRow?.projectId,
			"typing on a project page prepares that project's own draft",
		).toBe(firstId);

		await ensureSidebarExpanded(page);
		const row = projectRow(page, second);
		await row.hover();
		await row.getByRole("button", { name: `Open ${second}` }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${secondId}$`));
		await expect(page.getByTestId("project-greeting")).toHaveText(second);
		await waitForHydration(page);

		await sendMessage(page, "Flights to Lisbon.");
		await page.waitForURL(/\/chat\//, { timeout: 20000 });

		const chatId = page.url().match(/\/chat\/([^/?#]+)/)?.[1] ?? "";
		const [chatRow] = await db
			.select({ projectId: conversations.projectId })
			.from(conversations)
			.where(eq(conversations.id, chatId))
			.limit(1);
		expect(chatRow, `conversation ${chatId} must exist`).toBeTruthy();
		expect(
			chatRow.projectId,
			`the chat ${chatId} must belong to ${secondId}, not to the project left behind (${firstId}, whose draft was ${firstDraftId})`,
		).toBe(secondId);
	});

	test("does not adopt a draft whose creation was still in flight when the page moved", async ({
		page,
	}) => {
		// The same move, with the window left open: the first keystroke asks the
		// server for a conversation and the user opens another project before the
		// answer arrives. The reply was asked for by the project the keystroke was
		// typed in, so it must not become this page's draft — the send that
		// follows has to land in the project on screen.
		const first = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const second = `Lisbon trip ${randomUUID().slice(0, 8)}`;
		const firstId = await createProject(page, first);
		const secondId = await createProject(page, second);

		let heldOnce = false;
		await page.route("**/api/conversations", async (route) => {
			if (route.request().method() === "POST" && !heldOnce) {
				heldOnce = true;
				await new Promise((resolve) => setTimeout(resolve, 1500));
			}
			await route.continue();
		});

		await openProjectPage(page, firstId);
		await page.getByTestId("message-input").fill("Trains to Vienna.");
		await expect.poll(() => heldOnce).toBe(true);

		await ensureSidebarExpanded(page);
		const row = projectRow(page, second);
		await row.hover();
		await row.getByRole("button", { name: `Open ${second}` }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${secondId}$`));
		await expect(page.getByTestId("project-greeting")).toHaveText(second);
		// Let the held creation land before the send, so the test exercises the
		// adoption rather than the ordinary "no draft at all" path.
		await page.waitForTimeout(2000);
		await waitForHydration(page);

		await sendMessage(page, "Flights to Lisbon.");
		await page.waitForURL(/\/chat\//, { timeout: 20000 });

		const chatId = page.url().match(/\/chat\/([^/?#]+)/)?.[1] ?? "";
		const [chatRow] = await db
			.select({ projectId: conversations.projectId })
			.from(conversations)
			.where(eq(conversations.id, chatId))
			.limit(1);
		expect(chatRow, `conversation ${chatId} must exist`).toBeTruthy();
		expect(
			chatRow.projectId,
			`the chat ${chatId} must belong to ${secondId}, not to the project whose in-flight creation answered late (${firstId})`,
		).toBe(secondId);

		// And the conversation that late answer carried is not left behind as a
		// draft row in the project the user walked away from: nothing will ever
		// be written into it from this page.
		await expect
			.poll(async () => {
				const leftBehind = await db
					.select({ id: conversations.id })
					.from(conversations)
					.where(eq(conversations.projectId, firstId));
				return leftBehind.length;
			})
			.toBe(0);
	});

	test("opens the instructions dialog with only the project scope from the quiet line", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);

		await openProjectPage(page, projectId);
		await page.getByTestId("project-instructions-button").click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 10000 });
		await expect(
			dialog.getByRole("heading", { name: "Instructions" }),
		).toBeVisible();
		// The scope is a token, never a word in a sentence.
		await expect(dialog.getByText(projectName, { exact: true })).toBeVisible();
		// One scope passed means no switch to render — there is no personal
		// buffer on this page to switch to.
		await expect(page.getByTestId("instructions-scope-switch")).toHaveCount(0);

		const box = dialog.getByRole("textbox", {
			name: `Instructions for ${projectName}`,
		});
		await box.fill("Only suggest trains, never flights.");
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		// The chip says what is now true, and a reload proves the text reached
		// the database rather than the page.
		await expect(page.getByTestId("project-instructions-button")).toHaveText(
			"Instructions",
		);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("project-instructions-button")).toHaveText(
			"Instructions",
			{ timeout: 15000 },
		);
		await waitForHydration(page);
		await page.getByTestId("project-instructions-button").click();
		await expect(
			page.getByRole("dialog").getByRole("textbox", {
				name: `Instructions for ${projectName}`,
			}),
		).toHaveValue("Only suggest trains, never flights.");
	});

	test("carries none of one project's instructions onto another project's page", async ({
		page,
	}) => {
		// `/projects/[projectId]` is one route, so the sidebar's "open another
		// project" is a client-side navigation: the page component is reused and
		// only its `data` changes. Anything the page seeds from the load into
		// `$state` has to notice that, or the second project's page shows the
		// first one's instruction text and — if the reader presses Save without
		// touching the box — writes it into the second project.
		const firstName = `Alpha trip ${randomUUID().slice(0, 8)}`;
		const secondName = `Beta trip ${randomUUID().slice(0, 8)}`;
		const firstProjectId = await createProject(page, firstName);
		const secondProjectId = await createProject(page, secondName);

		await openProjectPage(page, firstProjectId);
		await page.getByTestId("project-instructions-button").click();
		const firstDialog = page.getByRole("dialog");
		await firstDialog
			.getByRole("textbox", { name: `Instructions for ${firstName}` })
			.fill("Only suggest trains, never flights.");
		await firstDialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByTestId("project-instructions-button")).toHaveText(
			"Instructions",
		);

		// The second project has no instructions of its own, opened the way the
		// sidebar opens it.
		await ensureSidebarExpanded(page);
		const row = projectRow(page, secondName);
		await row.getByRole("button", { name: "Project options" }).click();
		await page
			.getByRole("menuitem", { name: `Create chat in ${secondName}` })
			.click();
		await expect(page).toHaveURL(new RegExp(`/projects/${secondProjectId}$`));
		await expect(page.getByTestId("project-greeting")).toHaveText(secondName);

		// Nothing was written to the second project by that navigation.
		await expect(page.getByTestId("project-instructions-button")).toHaveText(
			"Add instructions",
		);
		await page.getByTestId("project-instructions-button").click();
		await expect(
			page.getByRole("dialog").getByRole("textbox", {
				name: `Instructions for ${secondName}`,
			}),
		).toHaveValue("");
		const [row2] = await db
			.select({ instructions: projects.instructions })
			.from(projects)
			.where(eq(projects.id, secondProjectId))
			.limit(1);
		expect(row2?.instructions ?? null).toBeNull();
	});

	test("moves the caret into the composer when the menu item opens another project", async ({
		page,
	}) => {
		// The menu item's whole point is "start typing here", so it must land the
		// caret even when the surface it opens is the one already on screen —
		// the same route, reached from a different project's page.
		const firstName = `Alpha trip ${randomUUID().slice(0, 8)}`;
		const secondName = `Beta trip ${randomUUID().slice(0, 8)}`;
		const firstProjectId = await createProject(page, firstName);
		const secondProjectId = await createProject(page, secondName);

		await openProjectPage(page, firstProjectId);
		// A plain load does not steal the caret: it is the menu item that asks
		// for it.
		await expect(page.getByTestId("message-input")).not.toBeFocused();

		await ensureSidebarExpanded(page);
		const row = projectRow(page, secondName);
		await row.getByRole("button", { name: "Project options" }).click();
		await page
			.getByRole("menuitem", { name: `Create chat in ${secondName}` })
			.click();

		await expect(page).toHaveURL(new RegExp(`/projects/${secondProjectId}$`));
		await expect(page.getByTestId("message-input")).toBeFocused();
	});

	test("links the breadcrumb project segment back to the project page", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const chatId = await seedChat({
			projectId,
			title: "Train options Budapest to Vienna",
			updatedAt: hoursAgo(2),
		});

		await page.goto(`/chat/${chatId}`, { waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("message-input")).toBeVisible({
			timeout: 15000,
		});
		await waitForHydration(page);

		await page.getByTestId("chat-title-project-link").click();
		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
		await expect(page.getByTestId("project-greeting")).toHaveText(projectName);
	});

	test("redirects home for another user's project id", async ({ page }) => {
		// A project that exists and is somebody else's must be indistinguishable
		// from one that does not exist: no name, no chats, no hint that it is
		// real — just the landing page.
		const otherUserId = `e2e-other-${randomUUID()}`;
		const foreignName = `Someone else's trip ${randomUUID().slice(0, 8)}`;
		const foreignProjectId = randomUUID();
		await db.insert(users).values({
			id: otherUserId,
			email: `e2e-other-${randomUUID()}@local`,
			passwordHash: "not-a-real-hash",
		});
		await db.insert(projects).values({
			id: foreignProjectId,
			userId: otherUserId,
			name: foreignName,
		});

		await page.goto(`/projects/${foreignProjectId}`, {
			waitUntil: "domcontentloaded",
		});

		await expect(page).toHaveURL(/\/$/, { timeout: 15000 });
		await expect(page.getByTestId("message-input")).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByText(foreignName)).toHaveCount(0);
	});

	test("keeps the incognito arm on the project page and creates an incognito chat in the project", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);

		await openProjectPage(page, projectId);
		// Decision 13: the arm stays here, because an incognito chat in a project
		// still sees the project's instructions and files.
		await expect(page.getByTestId("incognito-arm")).toBeVisible();
		await page.getByTestId("incognito-arm").click();
		// The arm's job is done the moment the page is armed, not the moment it
		// vanishes: the button itself stays until a message has been sent (see
		// incognito-indicator.spec.ts), and the tint is what says it took.
		await expect(page.locator(".chat-stage")).toHaveClass(/stage--incognito/);

		await sendMessage(page, "Not this one.");
		await page.waitForURL(/\/chat\//, { timeout: 20000 });
		const chatId = page.url().match(/\/chat\/([^/?#]+)/)?.[1] ?? "";
		const [row] = await db
			.select({
				projectId: conversations.projectId,
				memoryIncognito: conversations.memoryIncognito,
			})
			.from(conversations)
			.where(eq(conversations.id, chatId))
			.limit(1);
		expect(row, `conversation ${chatId} must exist`).toBeTruthy();
		expect(row.projectId).toBe(projectId);
		expect(row.memoryIncognito).toBe(true);
	});
});
