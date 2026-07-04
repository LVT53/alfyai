import { expect, type Page, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	createConversation,
	ensureSidebarExpanded,
	login,
	openConversationComposer,
} from "./helpers";

async function createConversationTransfer(page: Page, conversationId: string) {
	return page.evaluateHandle(
		({ targetConversationId }) => {
			const transfer = new DataTransfer();
			transfer.setData(
				"application/x-alfyai-conversation",
				targetConversationId,
			);
			transfer.setData("text/plain", targetConversationId);
			return transfer;
		},
		{ targetConversationId: conversationId },
	);
}

function requireConversationId(
	conversationId: string | null | undefined,
): string {
	expect(conversationId).toBeTruthy();
	if (!conversationId) throw new Error("Expected created conversation id");
	return conversationId;
}

async function openProjectCreator(page: Page) {
	await ensureSidebarExpanded(page);

	const expandProjectsButton = page.getByRole("button", {
		name: "Expand Projects section",
	});
	if (await expandProjectsButton.isVisible().catch(() => false)) {
		await expandProjectsButton.click();
	}

	await expect(
		page.getByRole("button", { name: "Collapse Projects section" }),
	).toBeVisible({ timeout: 5000 });

	await page
		.getByRole("button", { name: "Create new project" })
		.first()
		.click();
	const projectInput = page.getByPlaceholder("Project name");
	await expect(projectInput).toBeVisible();
	return projectInput;
}

test.describe("Conversation CRUD operations", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
				body: buildAiSdkUiStreamBody("ok"),
			});
		});
	});

	test("sidebar new chat button opens the home composer", async ({ page }) => {
		await openConversationComposer(page);
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect(page).toHaveURL("/");
	});

	test("conversation appears in sidebar after the first send", async ({
		page,
	}) => {
		await createConversation(page);
		await ensureSidebarExpanded(page);
		await expect(page.getByTestId("conversation-item").first()).toBeVisible({
			timeout: 10000,
		});
	});

	test("renames a conversation", async ({ page }) => {
		await createConversation(page);
		await ensureSidebarExpanded(page);
		await expect(page.getByTestId("conversation-item").first()).toBeVisible({
			timeout: 10000,
		});

		const item = page.getByTestId("conversation-item").first();
		await item.hover();
		await item.getByRole("button", { name: "Conversation options" }).click();
		await page.getByTestId("rename-option").click();

		const titleInput = page.getByTestId("title-input");
		await expect(titleInput).toBeVisible();
		await titleInput.fill("Renamed Conversation");
		await titleInput.press("Enter");

		await expect(page.getByTestId("conversation-item").first()).toContainText(
			"Renamed Conversation",
			{ timeout: 10000 },
		);
	});

	test("cancels rename when pressing Escape", async ({ page }) => {
		await createConversation(page);
		await ensureSidebarExpanded(page);
		await expect(page.getByTestId("conversation-item").first()).toBeVisible({
			timeout: 10000,
		});

		const item = page.getByTestId("conversation-item").first();
		const _originalTitle =
			(await item.locator(".truncate").textContent()) ?? "";

		await item.hover();
		await item.getByRole("button", { name: "Conversation options" }).click();
		await page.getByTestId("rename-option").click();

		const titleInput = page.getByTestId("title-input");
		await titleInput.fill("This Should Not Save");
		await titleInput.press("Escape");

		await expect(page.getByTestId("title-input")).not.toBeVisible();
	});

	test("deletes a conversation with confirmation dialog", async ({ page }) => {
		await createConversation(page);
		await ensureSidebarExpanded(page);
		await expect(page.getByTestId("conversation-item").first()).toBeVisible({
			timeout: 10000,
		});

		const item = page.getByTestId("conversation-item").first();
		await item.hover();
		await item.getByRole("button", { name: "Conversation options" }).click();
		await page.getByTestId("delete-option").click();

		const deleteDialog = page.getByRole("dialog", {
			name: "Delete this conversation?",
		});
		await expect(deleteDialog).toBeVisible();

		await page.getByTestId("confirm-delete").click();

		await expect(deleteDialog).not.toBeVisible({ timeout: 5000 });
	});

	test("cancels deletion from confirmation dialog", async ({ page }) => {
		await createConversation(page);
		await ensureSidebarExpanded(page);
		await expect(page.getByTestId("conversation-item").first()).toBeVisible({
			timeout: 10000,
		});

		const initialCount = await page.getByTestId("conversation-item").count();

		const item = page.getByTestId("conversation-item").first();
		await item.hover();
		await item.getByRole("button", { name: "Conversation options" }).click();
		await page.getByTestId("delete-option").click();

		const deleteDialog = page.getByRole("dialog", {
			name: "Delete this conversation?",
		});
		await expect(deleteDialog).toBeVisible();
		await page.getByRole("button", { name: "Cancel" }).click();
		await expect(deleteDialog).not.toBeVisible();

		await expect(page.getByTestId("conversation-item")).toHaveCount(
			initialCount,
		);
	});

	test("drags a conversation into a project folder", async ({ page }) => {
		const conversationId = await createConversation(
			page,
			"Project drag conversation",
		);
		await ensureSidebarExpanded(page);

		const projectName = `Project Drag Target ${Date.now()}`;
		const projectInput = await openProjectCreator(page);
		await projectInput.fill(projectName);
		await projectInput.press("Enter");

		const _conversationItem = page.locator(
			`[data-conversation-id="${conversationId}"]`,
		);
		const projectTarget = page
			.getByTestId("project-drop-target")
			.filter({ hasText: projectName })
			.first();

		await expect(projectTarget).toBeVisible({ timeout: 10000 });
		const projectId = await projectTarget.getAttribute("data-project-id");

		expect(projectId).toBeTruthy();

		const moveRequestPromise = page.waitForRequest((request) => {
			return (
				request.method() === "PATCH" &&
				request.url().includes(`/api/conversations/${conversationId}`)
			);
		});

		const dataTransfer = await createConversationTransfer(
			page,
			requireConversationId(conversationId),
		);
		await projectTarget.dispatchEvent("dragover", { dataTransfer });
		await projectTarget.dispatchEvent("drop", { dataTransfer });

		const moveRequest = await moveRequestPromise;
		expect(moveRequest.postDataJSON()).toEqual({ projectId });
	});

	test("moves a conversation from one project folder into another", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Cross project drag conversation",
		);
		await ensureSidebarExpanded(page);

		const uniqueSuffix = Date.now();
		const firstProjectName = `First Drag Project ${uniqueSuffix}`;
		const projectInput = await openProjectCreator(page);
		await projectInput.fill(firstProjectName);
		await projectInput.press("Enter");

		await page
			.getByRole("button", { name: "Create new project" })
			.first()
			.click();
		await expect(projectInput).toBeVisible();
		const secondProjectName = `Second Drag Project ${uniqueSuffix}`;
		await projectInput.fill(secondProjectName);
		await projectInput.press("Enter");

		const firstProjectTarget = page
			.getByTestId("project-drop-target")
			.filter({ hasText: firstProjectName })
			.first();
		const secondProjectTarget = page
			.getByTestId("project-drop-target")
			.filter({ hasText: secondProjectName })
			.first();
		const _conversationItem = page.locator(
			`[data-conversation-id="${conversationId}"]`,
		);

		const firstProjectId =
			await firstProjectTarget.getAttribute("data-project-id");
		const secondProjectId =
			await secondProjectTarget.getAttribute("data-project-id");

		expect(firstProjectId).toBeTruthy();
		expect(secondProjectId).toBeTruthy();

		const firstMoveRequestPromise = page.waitForRequest((request) => {
			return (
				request.method() === "PATCH" &&
				request.url().includes(`/api/conversations/${conversationId}`)
			);
		});

		const firstTransfer = await createConversationTransfer(
			page,
			requireConversationId(conversationId),
		);
		await firstProjectTarget.dispatchEvent("dragover", {
			dataTransfer: firstTransfer,
		});
		await firstProjectTarget.dispatchEvent("drop", {
			dataTransfer: firstTransfer,
		});

		const firstMoveRequest = await firstMoveRequestPromise;
		expect(firstMoveRequest.postDataJSON()).toEqual({
			projectId: firstProjectId,
		});

		const movedConversationItem = page.locator(
			`[data-conversation-id="${conversationId}"]`,
		);

		const secondMoveRequestPromise = page.waitForRequest((request) => {
			return (
				request.method() === "PATCH" &&
				request.url().includes(`/api/conversations/${conversationId}`)
			);
		});

		const secondTransfer = await createConversationTransfer(
			page,
			requireConversationId(conversationId),
		);
		await movedConversationItem.dispatchEvent("dragstart", {
			dataTransfer: secondTransfer,
		});
		await secondProjectTarget.dispatchEvent("dragover", {
			dataTransfer: secondTransfer,
		});
		await secondProjectTarget.dispatchEvent("drop", {
			dataTransfer: secondTransfer,
		});
		await movedConversationItem.dispatchEvent("dragend", {
			dataTransfer: secondTransfer,
		});

		const secondMoveRequest = await secondMoveRequestPromise;
		expect(secondMoveRequest.postDataJSON()).toEqual({
			projectId: secondProjectId,
		});
	});

	test("moves a conversation from a project back to unorganized", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Return to unorganized conversation",
		);
		await ensureSidebarExpanded(page);

		const projectName = `Temporary Project ${Date.now()}`;
		const projectInput = await openProjectCreator(page);
		await projectInput.fill(projectName);
		await projectInput.press("Enter");

		const projectTarget = page
			.getByTestId("project-drop-target")
			.filter({ hasText: projectName })
			.first();
		const unorganizedTarget = page.getByTestId("unorganized-drop-target");
		const _conversationItem = page.locator(
			`[data-conversation-id="${conversationId}"]`,
		);

		const projectId = await projectTarget.getAttribute("data-project-id");

		expect(projectId).toBeTruthy();

		const moveIntoProjectRequestPromise = page.waitForRequest((request) => {
			return (
				request.method() === "PATCH" &&
				request.url().includes(`/api/conversations/${conversationId}`)
			);
		});

		const intoProjectTransfer = await createConversationTransfer(
			page,
			requireConversationId(conversationId),
		);
		await projectTarget.dispatchEvent("dragover", {
			dataTransfer: intoProjectTransfer,
		});
		await projectTarget.dispatchEvent("drop", {
			dataTransfer: intoProjectTransfer,
		});

		const moveIntoProjectRequest = await moveIntoProjectRequestPromise;
		expect(moveIntoProjectRequest.postDataJSON()).toEqual({ projectId });

		const movedConversationItem = page.locator(
			`[data-conversation-id="${conversationId}"]`,
		);
		await expect(unorganizedTarget).toContainText("Chats");

		const moveBackRequestPromise = page.waitForRequest((request) => {
			return (
				request.method() === "PATCH" &&
				request.url().includes(`/api/conversations/${conversationId}`)
			);
		});

		const backTransfer = await createConversationTransfer(
			page,
			requireConversationId(conversationId),
		);
		await movedConversationItem.dispatchEvent("dragstart", {
			dataTransfer: backTransfer,
		});
		await unorganizedTarget.dispatchEvent("dragover", {
			dataTransfer: backTransfer,
		});
		await unorganizedTarget.dispatchEvent("drop", {
			dataTransfer: backTransfer,
		});
		await movedConversationItem.dispatchEvent("dragend", {
			dataTransfer: backTransfer,
		});

		const moveBackRequest = await moveBackRequestPromise;
		expect(moveBackRequest.postDataJSON()).toEqual({ projectId: null });
	});

	test("keeps only one sidebar options menu open at a time", async ({
		page,
	}) => {
		await createConversation(page, "Single menu conversation");
		await ensureSidebarExpanded(page);

		const projectName = "Single Menu Project";
		const projectInput = await openProjectCreator(page);
		await projectInput.fill(projectName);
		await projectInput.press("Enter");

		const conversationItem = page.getByTestId("conversation-item").first();
		const projectTarget = page
			.getByTestId("project-drop-target")
			.filter({ hasText: projectName })
			.first();
		await conversationItem.hover();
		await conversationItem
			.getByRole("button", { name: "Conversation options" })
			.dispatchEvent("click");

		const conversationMenu = page.locator(".conversation-menu").first();
		const projectMenu = page.locator(".project-menu").first();

		await expect(conversationMenu).toBeVisible();
		await expect(projectMenu).not.toBeVisible();

		await projectTarget.hover();
		await projectTarget
			.getByRole("button", { name: "Project options" })
			.click();

		await expect(projectMenu).toBeVisible();
		await expect(conversationMenu).not.toBeVisible();

		await conversationItem
			.getByRole("button", { name: "Conversation options" })
			.click();

		await expect(conversationMenu).toBeVisible();
		await expect(projectMenu).not.toBeVisible();
	});

	test("confirms before logging out from the sidebar (ADR-0043 Slice 16)", async ({
		page,
	}) => {
		await ensureSidebarExpanded(page);

		// Clicking the sidebar Logout button opens a confirm dialog and does
		// NOT navigate away yet.
		await page.getByRole("button", { name: "Logout" }).click();
		await expect(page.getByText("Log out?")).toBeVisible();
		await expect(page).not.toHaveURL("/login");

		// Confirming ends the session.
		await page.getByTestId("confirm-delete").click();
		await expect(page).toHaveURL("/login");
	});
});
