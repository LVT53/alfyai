import { expect, type Page, test } from "@playwright/test";
import { login, openConversationComposer, waitForHydration } from "./helpers";

// `/instruction <text>` is a hand-off, not a turn: the argument is a line to
// add to the text the user already has, and the only surface that may write it
// is the shared instructions dialog, opened with the whole saved text on
// screen. Nothing here sends a message, and nothing is saved without a Save.

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

async function setPersonalInstructions(page: Page, text: string) {
	const result = await page.evaluate(async (value) => {
		const response = await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ personalInstructions: value }),
		});
		return { ok: response.ok, status: response.status };
	}, text);
	expect(result.ok, `Failed to set instructions: ${result.status}`).toBe(true);
}

async function createProject(
	page: Page,
	name: string,
	instructions: string,
): Promise<string> {
	const created = await page.evaluate(async (projectName) => {
		const response = await fetch("/api/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: projectName }),
		});
		return { ok: response.ok, body: await response.json() };
	}, name);
	expect(created.ok, "Failed to create the project").toBe(true);
	const projectId = (created.body as { id: string }).id;

	const saved = await page.evaluate(
		async ({ id, text }) => {
			const response = await fetch(`/api/projects/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ instructions: text }),
			});
			return { ok: response.ok, status: response.status };
		},
		{ id: projectId, text: instructions },
	);
	expect(saved.ok, `Failed to set project instructions: ${saved.status}`).toBe(
		true,
	);
	return projectId;
}

async function createConversation(page: Page): Promise<string> {
	const conversation = await page.evaluate(async () => {
		const result = await fetch("/api/conversations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Instruction command E2E" }),
		});
		if (!result.ok) {
			throw new Error(`Failed to create conversation: ${result.status}`);
		}
		return (await result.json()) as { id: string };
	});
	return conversation.id;
}

async function setConversationIncognito(page: Page, id: string) {
	const result = await page.evaluate(async (conversationId) => {
		const response = await fetch(`/api/conversations/${conversationId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ memoryIncognito: true }),
		});
		return { ok: response.ok, status: response.status };
	}, id);
	expect(result.ok, `Failed to arm incognito: ${result.status}`).toBe(true);
}

/** Types the command the way a user does, and runs it from the tray. */
async function runInstructionCommand(page: Page, text: string) {
	const input = page.getByTestId("message-input");
	await input.click();
	await input.fill("");
	await input.pressSequentially(text);
	await input.press("Enter");
}

const personalBox = (page: Page) =>
	page.getByRole("textbox", { name: "Instructions for Personal" });

test.describe("instructions from the composer", () => {
	test("appends the argument to the saved text, saves the whole thing, and sends nothing", async ({
		page,
	}) => {
		await login(page);
		await setComposerCommandRegistry(page, true);
		await setPersonalInstructions(page, "Always answer in Hungarian.");
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await openConversationComposer(page);
		await waitForHydration(page);

		await runInstructionCommand(page, "/instruction Only suggest trains.");

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 10000 });
		// The saved text is drawn with the new line at the end of it — the user
		// reviews the whole instruction, not just the addition.
		await expect(personalBox(page)).toHaveValue(
			"Always answer in Hungarian.\nOnly suggest trains.",
		);
		// And the addition is marked as the addition.
		await expect(dialog.locator("mark")).toHaveText("Only suggest trains.");
		// Outside a project there is nothing to switch to.
		await expect(page.getByTestId("instructions-scope-switch")).toHaveCount(0);

		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		// The command was consumed, not sent: the composer is empty and no turn
		// was started by the command itself.
		await expect(page.getByTestId("message-input")).toHaveValue("");
		await expect(page.getByTestId("send-button")).toBeVisible();

		// Reopening reads the text back off the server, so the Save above went
		// somewhere real rather than into the box it was drawn from.
		await runInstructionCommand(page, "/instruction And be brief.");
		await expect(personalBox(page)).toHaveValue(
			"Always answer in Hungarian.\nOnly suggest trains.\nAnd be brief.",
		);
	});

	test("keeps a bare /instruction in the composer and says what is missing", async ({
		page,
	}) => {
		await login(page);
		await setComposerCommandRegistry(page, true);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await openConversationComposer(page);
		await waitForHydration(page);

		await runInstructionCommand(page, "/instruction");

		// The command is refused out loud, in the composer's own message row.
		await expect(
			page.getByText("Write the instruction after /instruction."),
		).toBeVisible({ timeout: 10000 });
		// Not consumed: the token is still there to be typed into.
		await expect(page.getByTestId("message-input")).toHaveValue(
			"/instruction",
		);
		await expect(page.getByRole("dialog")).toHaveCount(0);
	});

	test("opens on the project scope, named, with the personal text loaded beside it", async ({
		page,
	}) => {
		await login(page);
		await setComposerCommandRegistry(page, true);
		await setPersonalInstructions(page, "Be brief.");
		const projectId = await createProject(
			page,
			"Trains",
			"Only suggest trains.",
		);

		await page.goto(`/projects/${projectId}`, { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await expect(page.getByTestId("message-input")).toBeEnabled({
			timeout: 15000,
		});

		await runInstructionCommand(page, "/instruction Also mention platforms.");

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 10000 });
		// A project scope token without a name is an icon with no text, so the
		// name has to have come back with the text — on the dialog's own token
		// and on the switch entry that offers the same scope.
		const headToken = dialog
			.locator(".instructions-head")
			.getByTestId("scope-token");
		await expect(headToken).toHaveText("Trains");
		await expect(headToken).toHaveAttribute("aria-label", "Project Trains");
		await expect(page.getByTestId("instructions-scope-switch")).toBeVisible();
		await expect(
			page.getByRole("textbox", { name: "Instructions for Trains" }),
		).toHaveValue("Only suggest trains.\nAlso mention platforms.");

		// Switching scope carries the not-yet-saved line with the user (the
		// dialog's own rule), so the personal scope shows its saved text with
		// the same pending addition on top. Nothing has been written to either
		// scope at this point, which is the point: Save is the only writer.
		await page
			.getByTestId("instructions-scope-switch")
			.getByRole("button", { name: /Personal/ })
			.click();
		await expect(personalBox(page)).toHaveValue(
			"Be brief.\nAlso mention platforms.",
		);
	});

	// Incognito turns nothing about the instructions away: they are not a
	// memory, and the dialog writes them the same way here as anywhere else.
	test("works in an incognito chat", async ({ page }) => {
		await login(page);
		await setComposerCommandRegistry(page, true);
		await setPersonalInstructions(page, "Prefer metric units.");
		const conversationId = await createConversation(page);
		await setConversationIncognito(page, conversationId);

		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await waitForHydration(page);
		await expect(page.getByTestId("message-input")).toBeEnabled({
			timeout: 15000,
		});

		await runInstructionCommand(page, "/instruction Never mention prices.");

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 10000 });
		await expect(personalBox(page)).toHaveValue(
			"Prefer metric units.\nNever mention prices.",
		);

		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		await runInstructionCommand(page, "/instruction And keep it short.");
		await expect(personalBox(page)).toHaveValue(
			"Prefer metric units.\nNever mention prices.\nAnd keep it short.",
		);
	});
});
