import { expect, type Page, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	login,
	openConversationComposer,
} from "./helpers";

async function setComposerCommandRegistry(page: Page, enabled: boolean) {
	const response = await page.evaluate(async (nextEnabled) => {
		const result = await fetch("/api/admin/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				COMPOSER_COMMAND_REGISTRY_ENABLED: String(nextEnabled),
			}),
		});
		return { ok: result.ok, status: result.status };
	}, enabled);
	expect(response.ok, `Failed to set composer flag: ${response.status}`).toBe(
		true,
	);
}

async function createEmptyConversation(page: Page): Promise<string> {
	const conversation = await page.evaluate(async () => {
		const result = await fetch("/api/conversations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Composer Command V1 E2E" }),
		});
		if (!result.ok) {
			throw new Error(`Failed to create conversation: ${result.status}`);
		}
		return (await result.json()) as { id: string };
	});
	return conversation.id;
}

async function typeComposerCommand(page: Page, command: string) {
	const input = page.getByTestId("message-input");
	await input.fill("");
	await input.click();
	await input.pressSequentially(command);
}

async function mockComposerCommandRoutes(
	page: Page,
	capture: { streamBody?: Record<string, unknown> },
) {
	await page.route("**/api/skills/discovery**", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				skills: [
					{
						id: "skill-interview",
						ownership: "user",
						displayName: "Interview coach",
						description: "Practice interview answers.",
						activationExamples: ["interview me"],
						enabled: true,
						durationPolicy: "session",
						questionPolicy: "ask_when_needed",
						notesPolicy: "none",
						sourceScope: "selected_sources_only",
						creationSource: "user_created",
						version: 1,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}),
		});
	});

	await page.route("**/api/knowledge", async (route) => {
		if (route.request().method() !== "GET") {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documents: [
					{
						id: "display-alpha",
						displayArtifactId: "display-alpha",
						promptArtifactId: "prompt-alpha",
						familyArtifactIds: ["display-alpha", "prompt-alpha"],
						name: "Alpha source.md",
						mimeType: "text/markdown",
						sizeBytes: 120,
						conversationId: null,
						summary: "Alpha source",
						normalizedAvailable: true,
						documentOrigin: "uploaded",
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: "display-beta",
						displayArtifactId: "display-beta",
						promptArtifactId: "prompt-beta",
						familyArtifactIds: ["display-beta", "prompt-beta"],
						name: "Beta source.pdf",
						mimeType: "application/pdf",
						sizeBytes: 240,
						conversationId: null,
						summary: "Beta source",
						normalizedAvailable: true,
						documentOrigin: "generated",
						createdAt: 2,
						updatedAt: 2,
					},
				],
				results: [],
				workflows: [],
			}),
		});
	});

	await page.route("**/api/knowledge/upload**", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				artifact: {
					id: "artifact-uploaded",
					type: "source_document",
					retrievalClass: "durable",
					name: "brief.txt",
					mimeType: "text/plain",
					sizeBytes: 12,
					conversationId: "conv-e2e",
					summary: "Uploaded brief",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: "prompt-uploaded",
				readinessError: null,
			}),
		});
	});

	await page.route("**/api/conversations/**/skill-sessions", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				activeSkillSession: {
					id: "session-e2e",
					userId: "user-e2e",
					conversationId: "conv-e2e",
					skillId: "skill-interview",
					skillOwnership: "user",
					status: "active",
					pauseReason: null,
					endReason: null,
					skillDisplayName: "Interview coach",
					skillDescription: "Practice interview answers.",
					activationExamples: ["interview me"],
					durationPolicy: "session",
					questionPolicy: "ask_when_needed",
					notesPolicy: "none",
					sourceScope: "selected_sources_only",
					skillVersion: 1,
					startedFrom: "pending_skill",
					startedAt: Date.now(),
					updatedAt: Date.now(),
					pausedAt: null,
					endedAt: null,
					milestones: [],
				},
			}),
		});
	});

	await page.route("**/api/chat/stream", async (route) => {
		capture.streamBody = JSON.parse(
			route.request().postData() ?? "{}",
		) as Record<string, unknown>;
		await route.fulfill({
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
			},
			body: buildAiSdkUiStreamBody("Mixed command response"),
		});
	});
}

async function mockVariantComposerRoutes(
	page: Page,
	capture: { streamBody?: Record<string, unknown> },
) {
	await page.route("**/api/skills/discovery**", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				skills: [
					{
						id: "variant-research-concise",
						ownership: "user",
						skillKind: "skill_variant",
						baseSkillId: "system:research",
						baseSkillDisplayName: "Research Pack",
						displayName: "Research Pack, concise",
						description: "Use concise answers.",
						activationExamples: ["research concise"],
						enabled: true,
						durationPolicy: "session",
						questionPolicy: "ask_when_needed",
						notesPolicy: "none",
						sourceScope: "selected_sources_only",
						creationSource: "user_created",
						version: 2,
						createdAt: 1,
						updatedAt: 2,
					},
				],
			}),
		});
	});

	await page.route("**/api/conversations/**/skill-sessions", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				activeSkillSession: {
					id: "session-variant-e2e",
					userId: "user-e2e",
					conversationId: "conv-e2e",
					skillId: "variant-research-concise",
					skillOwnership: "user",
					skillKind: "skill_variant",
					baseSkillId: "system:research",
					baseSkillDisplayName: "Research Pack",
					status: "active",
					pauseReason: null,
					endReason: null,
					skillDisplayName: "Research Pack, concise",
					skillDescription: "Use concise answers.",
					activationExamples: ["research concise"],
					durationPolicy: "session",
					questionPolicy: "ask_when_needed",
					notesPolicy: "none",
					sourceScope: "selected_sources_only",
					skillVersion: 2,
					baseSkillVersion: 4,
					startedFrom: "pending_skill",
					startedAt: Date.now(),
					updatedAt: Date.now(),
					pausedAt: null,
					endedAt: null,
					milestones: [],
				},
			}),
		});
	});

	await page.route("**/api/chat/stream", async (route) => {
		capture.streamBody = JSON.parse(
			route.request().postData() ?? "{}",
		) as Record<string, unknown>;
		await route.fulfill({
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
			},
			body: buildAiSdkUiStreamBody("Variant command response"),
		});
	});
}

test.describe("Composer Command V1", () => {
	test("feature flag off hides the command tray and blocks skill discovery", async ({
		page,
	}) => {
		await login(page);
		await setComposerCommandRegistry(page, false);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await openConversationComposer(page);

		await page.getByTestId("message-input").fill("/");
		await expect(
			page.getByRole("listbox", { name: "Composer commands" }),
		).toBeHidden();

		const discovery = await page.evaluate(async () => {
			const result = await fetch("/api/composer-commands");
			return { status: result.status, body: await result.json() };
		});
		expect(discovery.status).toBe(404);
		expect(discovery.body).toMatchObject({
			errorKey: "composerCommandRegistry.disabled",
		});
	});

	test("landing command trigger opens the tray without creating a draft conversation", async ({
		page,
	}) => {
		await login(page);
		await setComposerCommandRegistry(page, true);
		let createConversationAttempts = 0;
		await page.route("**/api/conversations", async (route) => {
			if (route.request().method() === "POST") {
				createConversationAttempts += 1;
				await route.fulfill({
					status: 404,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ error: "unexpected create conversation" }),
				});
				return;
			}
			await route.continue();
		});
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await openConversationComposer(page);

		await typeComposerCommand(page, "/");
		await expect(
			page.getByRole("listbox", { name: "Composer commands" }),
		).toBeVisible();
		expect(createConversationAttempts).toBe(0);

		await typeComposerCommand(page, "$");
		await expect(
			page.getByRole("listbox", { name: "Composer commands" }),
		).toBeVisible();
		expect(createConversationAttempts).toBe(0);
	});

	test("mixes skill, linked sources, upload, and thinking mode in one normal chat turn", async ({
		page,
	}) => {
		const capture: { streamBody?: Record<string, unknown> } = {};

		await login(page);
		const themeResponse = await page.evaluate(async () => {
			const result = await fetch("/api/settings/preferences", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ theme: "dark" }),
			});
			return { ok: result.ok, status: result.status };
		});
		expect(
			themeResponse.ok,
			`Failed to switch test user to dark mode: ${themeResponse.status}`,
		).toBe(true);
		await setComposerCommandRegistry(page, true);
		await mockComposerCommandRoutes(page, capture);
		const conversationId = await createEmptyConversation(page);
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await page.waitForLoadState("networkidle");
		await expect
			.poll(() =>
				page
					.locator("html")
					.evaluate((element) => element.classList.contains("dark")),
			)
			.toBe(true);
		await expect(page.getByTestId("message-input")).toBeVisible();

		const input = page.getByTestId("message-input");

		await typeComposerCommand(page, "$interview");
		await page.getByRole("option", { name: /Interview coach/i }).click();
		await expect(
			page.getByRole("button", {
				name: "Remove pending skill Interview coach",
			}),
		).toBeVisible();
		const pendingSkill = page.getByRole("list", { name: "Pending skill" });
		await expect(pendingSkill.locator(".pending-skill-chip")).toBeVisible();
		await expect(pendingSkill.locator(".linked-source-chip")).toHaveCount(0);

		await typeComposerCommand(page, "/document");
		await page.getByRole("option", { name: /\/document/i }).click();
		const picker = page.getByRole("dialog", { name: "Link Library documents" });
		await expect(picker).toBeVisible();
		await expect
			.poll(() =>
				picker.evaluate((element) => getComputedStyle(element).backgroundColor),
			)
			.not.toBe("rgb(255, 255, 255)");
		await picker.getByRole("checkbox", { name: "Alpha source.md" }).check();
		await picker.getByRole("checkbox", { name: "Beta source.pdf" }).check();
		await page.getByRole("button", { name: "Link selected documents" }).click();
		await expect(page.getByText("Alpha source.md")).toBeVisible();
		await expect(page.getByText("Beta source.pdf")).toBeVisible();

		await typeComposerCommand(page, "/source");
		await page.getByRole("option", { name: /\/source/i }).click();
		const sourceManager = page.getByRole("dialog", { name: "Sources" });
		await expect(sourceManager).toBeVisible();
		await expect
			.poll(() =>
				sourceManager.evaluate(
					(element) => getComputedStyle(element).backgroundColor,
				),
			)
			.not.toBe("rgb(255, 255, 255)");
		await sourceManager.getByRole("button", { name: "Close sources" }).click();

		await typeComposerCommand(page, "/thinking");
		await page.getByRole("option", { name: /\/thinking/i }).click();
		await page.getByRole("option", { name: "Off" }).click();

		await typeComposerCommand(page, "/attach");
		await page.getByRole("option", { name: /\/attach/i }).click();
		await page.locator('input[type="file"]').setInputFiles({
			name: "brief.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("brief text"),
		});
		await expect(page.getByText("brief.txt", { exact: true })).toBeVisible();

		await input.fill("Use every selected composer command in normal chat.");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Mixed command response",
			{
				timeout: 15000,
			},
		);
		const activeSkill = page.getByRole("region", { name: "Skill session" });
		await expect(activeSkill).toContainText("Interview coach");
		await expect(
			activeSkill.getByRole("button", { name: "Stop skill" }),
		).toBeVisible();
		const panelBox = await activeSkill.boundingBox();
		const composerBox = await page.locator(".message-composer").boundingBox();
		if (!panelBox || !composerBox) {
			throw new Error("Active skill panel or composer box was not measurable.");
		}
		expect(panelBox.width).toBeLessThan(composerBox.width);
		expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(composerBox.y + 4);

		await typeComposerCommand(page, "/");
		const activeTray = page.getByRole("listbox", { name: "Composer commands" });
		await expect(activeTray).toBeVisible();
		const firstOption = activeTray.getByRole("option").first();
		const firstOptionBox = await firstOption.boundingBox();
		if (!firstOptionBox) {
			throw new Error("Command tray option was not measurable.");
		}
		await expect
			.poll(() =>
				page.evaluate(
					({ x, y }) => {
						const element = document.elementFromPoint(x, y);
						return Boolean(element?.closest("#composer-command-tray"));
					},
					{
						x: firstOptionBox.x + firstOptionBox.width / 2,
						y: firstOptionBox.y + firstOptionBox.height / 2,
					},
				),
			)
			.toBe(true);
		await page.keyboard.press("Escape");

		await expect.poll(() => capture.streamBody).toBeTruthy();
		expect(capture.streamBody).toMatchObject({
			message: "Use every selected composer command in normal chat.",
			attachmentIds: ["artifact-uploaded"],
			thinkingMode: "off",
			pendingSkill: {
				id: "skill-interview",
				ownership: "user",
				displayName: "Interview coach",
			},
		});
		expect(capture.streamBody?.linkedSources).toEqual([
			expect.objectContaining({
				displayArtifactId: "display-alpha",
				promptArtifactId: "prompt-alpha",
				name: "Alpha source.md",
			}),
			expect.objectContaining({
				displayArtifactId: "display-beta",
				promptArtifactId: "prompt-beta",
				name: "Beta source.pdf",
			}),
		]);
	});

	test("discovers a Skill Variant and sends its base-pack metadata", async ({
		page,
	}) => {
		const capture: { streamBody?: Record<string, unknown> } = {};

		await login(page);
		await setComposerCommandRegistry(page, true);
		await mockVariantComposerRoutes(page, capture);
		const conversationId = await createEmptyConversation(page);
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("message-input")).toBeVisible();

		await typeComposerCommand(page, "$concise");
		await page.getByRole("option", { name: /Research Pack, concise/i }).click();
		await expect(
			page.getByRole("button", {
				name: "Remove pending skill Research Pack, concise",
			}),
		).toBeVisible();
		await expect(
			page.getByRole("list", { name: "Pending skill" }),
		).toContainText("Skill Variant");

		await page
			.getByTestId("message-input")
			.fill("Summarize the attached ratio workbook.");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Variant command response",
			{ timeout: 15000 },
		);
		await expect.poll(() => capture.streamBody).toBeTruthy();
		expect(capture.streamBody).toMatchObject({
			message: "Summarize the attached ratio workbook.",
			pendingSkill: {
				id: "variant-research-concise",
				ownership: "user",
				skillKind: "skill_variant",
				displayName: "Research Pack, concise",
				baseSkillId: "system:research",
				baseSkillDisplayName: "Research Pack",
			},
		});
	});

	test("mobile tray stays above the composer with reduced motion", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.emulateMedia({ reducedMotion: "reduce" });
		await login(page);
		await setComposerCommandRegistry(page, true);
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildAiSdkUiStreamBody("Ready"),
			});
		});
		const conversationId = await createEmptyConversation(page);
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect
			.poll(async () =>
				page.evaluate(async () => {
					const result = await fetch("/api/composer-commands");
					return result.status;
				}),
			)
			.toBe(200);
		const closeSidebar = page.getByRole("button", { name: "Close sidebar" });
		if (await closeSidebar.isVisible().catch(() => false)) {
			await closeSidebar.evaluate((element) => {
				(element as HTMLButtonElement).click();
			});
		}

		await typeComposerCommand(page, "/");
		await expect(page.getByTestId("message-input")).toHaveValue("/");
		const tray = page.getByRole("listbox", { name: "Composer commands" });
		await expect(tray).toBeVisible();

		const trayBox = await tray.boundingBox();
		const composerBox = await page.locator(".message-composer").boundingBox();
		if (!trayBox || !composerBox) {
			throw new Error("Command tray or composer box was not measurable.");
		}
		expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(composerBox.y + 4);

		await page.keyboard.press("Escape");
		await expect(tray).toBeHidden();
	});
});
