import { expect, type Page, test } from "@playwright/test";

import { login } from "./helpers";

// Smoke coverage for the redesigned Profile tab: the shell no longer resizes
// between tabs, the desktop lays the six cards into two columns, and the phone
// stacks them with the jump-list and 44px targets.

const CARD_TITLES = [
	"Your account",
	"Preferences",
	"Assistant behaviour",
	"Data & privacy",
	"Your Activity",
	"Things that cannot be undone",
];

async function openSettings(page: Page) {
	await page.goto("/settings", { waitUntil: "domcontentloaded" });
	await page.waitForLoadState("networkidle");
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible(
		{ timeout: 15000 },
	);
}

function cardBox(page: Page, title: string) {
	return page
		.getByRole("heading", { name: title, exact: true })
		.locator("xpath=ancestor::section[1]")
		.boundingBox();
}

function assistantCard(page: Page) {
	return page
		.getByRole("heading", { name: "Assistant behaviour", exact: true })
		.locator("xpath=ancestor::section[1]");
}

// Longer than the row is wide at either viewport, so "the preview truncates"
// is a real measurement rather than a string that happened to fit.
const LONG_INSTRUCTIONS =
	"Answer briefly unless I ask for detail. Metric units and 24-hour time. No emoji, no exclamation marks.";

test.describe("Profile tab — desktop", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
	});

	test("shows all six cards in two columns, with no sub-tab pills", async ({
		page,
	}) => {
		await openSettings(page);

		for (const title of CARD_TITLES) {
			await expect(
				page.getByRole("heading", { name: title, exact: true }),
			).toBeVisible();
		}

		// The five anchor pills are gone at this width.
		await expect(
			page.getByRole("navigation", { name: "Profile sections" }),
		).toHaveCount(0);
		await expect(
			page.getByRole("navigation", { name: "Jump to a section" }),
		).toBeHidden();

		// Two columns: the identity card sits to the LEFT of Preferences, and
		// the two share a top edge.
		const account = await cardBox(page, "Your account");
		const preferences = await cardBox(page, "Preferences");
		if (!account || !preferences) throw new Error("Cards did not lay out");
		expect(account.x + account.width).toBeLessThanOrEqual(preferences.x + 1);
		expect(Math.abs(account.y - preferences.y)).toBeLessThan(4);

		// The irreversible actions are below everything in the left column.
		const danger = await cardBox(page, "Things that cannot be undone");
		if (!danger) throw new Error("Danger card did not lay out");
		expect(danger.y).toBeGreaterThan(account.y + account.height);
	});

	test("keeps one shell width across the three tabs, so the switcher never moves", async ({
		page,
	}) => {
		await openSettings(page);

		const switcher = page.getByRole("tablist", { name: "Settings" });
		const onProfile = await switcher.boundingBox();

		await page.getByRole("tab", { name: "Connections" }).click();
		await expect(
			page.getByRole("tab", { name: "Connections" }),
		).toHaveAttribute("aria-selected", "true");
		const onConnections = await switcher.boundingBox();

		if (!onProfile || !onConnections) {
			throw new Error("Expected the switcher to be laid out on both tabs");
		}
		expect(Math.abs(onProfile.width - onConnections.width)).toBeLessThan(2);
		expect(Math.abs(onProfile.x - onConnections.x)).toBeLessThan(2);
	});

	test("one Save, with Discard inert until something is dirty", async ({
		page,
	}) => {
		await openSettings(page);

		const save = page.getByTestId("account-save");
		const discard = page.getByTestId("account-discard");
		await expect(save).toBeVisible();
		await expect(discard).toBeDisabled();

		// Two Saves became one.
		await expect(
			page.getByRole("button", { name: "Change Password", exact: true }),
		).toHaveCount(0);

		const nameField = page.getByRole("textbox", { name: "Display Name" });
		const original = await nameField.inputValue();
		await nameField.fill(`${original} edited`);
		await expect(discard).toBeEnabled();

		await discard.click();
		await expect(nameField).toHaveValue(original);
		await expect(discard).toBeDisabled();
	});

	test("the group eyebrows are still eyebrows, not body text", async ({
		page,
	}) => {
		await openSettings(page);

		// `.settings-group-label` is shared settings grammar. The Profile
		// rebuild kept the class on its "Profile" eyebrow and its "Change
		// password — optional" sub-label after deleting the scoped rule that
		// drew it, so both printed as plain text at the wrong size.
		for (const label of [
			page.locator("p.settings-group-label").first(),
			page.getByText("Change password — optional"),
		]) {
			await expect(label).toBeVisible();
			await expect(label).toHaveCSS("text-transform", "uppercase");
			await expect(label).toHaveCSS("font-size", "11px");
			await expect(label).toHaveCSS("font-weight", "600");
		}

		// And the one line under the eyebrow is the small help size.
		await expect(page.locator("p.settings-help-text").first()).toHaveCSS(
			"font-size",
			"12px",
		);

		// The rule is shared, not Profile's: Connections reads the same one.
		await page.getByRole("tab", { name: "Connections" }).click();
		await expect(
			page.getByRole("tab", { name: "Connections" }),
		).toHaveAttribute("aria-selected", "true");
		const connectionsEyebrow = page.locator("p.settings-group-label").first();
		await expect(connectionsEyebrow).toBeVisible();
		await expect(connectionsEyebrow).toHaveCSS("text-transform", "uppercase");
		await expect(connectionsEyebrow).toHaveCSS("font-size", "11px");
	});

	test("rows light up on hover without moving", async ({ page }) => {
		await openSettings(page);

		// Match the `settings-row` class TOKEN: `settings-row-text` and
		// `settings-rows` would both satisfy a naive contains().
		const row = page
			.getByText("Appearance", { exact: true })
			.locator(
				"xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' settings-row ')][1]",
			);
		const before = await row.boundingBox();
		const restingBackground = await row.evaluate(
			(el) => getComputedStyle(el).backgroundColor,
		);

		await row.hover();
		// The background fades in over --duration-standard, and a computed
		// style read on the first frame still returns the resting value.
		await expect
			.poll(() => row.evaluate((el) => getComputedStyle(el).backgroundColor))
			.not.toBe(restingBackground);
		const after = await row.boundingBox();

		if (!before || !after) throw new Error("Row did not lay out");
		expect(Math.abs(before.x - after.x)).toBeLessThan(1);
		expect(Math.abs(before.y - after.y)).toBeLessThan(1);
	});
});

test.describe("Assistant behaviour — personal instructions", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
	});

	test("is the first row above Memory, and one dialog is the only way to change it", async ({
		page,
	}) => {
		await openSettings(page);

		const card = assistantCard(page);
		const rows = card.locator("div.settings-row");
		await expect(rows.first()).toContainText("Personal instructions");
		await expect(rows.nth(1)).toContainText("Memory");

		// Whatever a previous run left behind is cleared first, so "nothing is
		// set" is a state this test makes rather than one it hopes for.
		const open = card.getByTestId("personal-instructions-open");
		await open.click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole("heading", { name: "Instructions" }),
		).toHaveCount(1);
		await expect(dialog.getByText("You", { exact: true })).toBeVisible();
		await expect(dialog.getByText("/ 2000")).toBeVisible();

		const box = page.getByRole("textbox", {
			name: "Instructions for Personal",
		});
		await box.fill("");
		await page
			.getByRole("dialog")
			.getByRole("button", { name: "Save" })
			.click();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		await expect(card.getByTestId("personal-instructions-preview")).toHaveText(
			"Not set",
		);
		await expect(card.getByTestId("personal-instructions-open")).toContainText(
			"Add instructions",
		);

		// Now set one, in the same dialog the /instruction entry point opens.
		await card.getByTestId("personal-instructions-open").click();
		await page
			.getByRole("textbox", { name: "Instructions for Personal" })
			.fill(LONG_INSTRUCTIONS);
		await page
			.getByRole("dialog")
			.getByRole("button", { name: "Save" })
			.click();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		await expect(card.getByTestId("personal-instructions-preview")).toHaveText(
			LONG_INSTRUCTIONS,
		);
		await expect(card.getByTestId("personal-instructions-open")).toContainText(
			"Edit",
		);

		// Persisted, not just held in the page.
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(
			assistantCard(page).getByTestId("personal-instructions-preview"),
		).toHaveText(LONG_INSTRUCTIONS, { timeout: 15000 });
	});
});

test.describe("Profile tab — 390px", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await login(page);
	});

	test("the instructions row's button is a 44px target and the preview never wraps", async ({
		page,
	}) => {
		await openSettings(page);

		await assistantCard(page).getByTestId("personal-instructions-open").click();
		const box = page.getByRole("textbox", {
			name: "Instructions for Personal",
		});
		await box.fill(LONG_INSTRUCTIONS);
		await page
			.getByRole("dialog")
			.getByRole("button", { name: "Save" })
			.click();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		const button = assistantCard(page).getByTestId(
			"personal-instructions-open",
		);
		const box2 = await button.boundingBox();
		if (!box2) throw new Error("Instructions button did not lay out");
		expect(box2.height).toBeGreaterThanOrEqual(44);

		// The preview is one line that truncates: the full text is in the
		// dialog, and a row that grows to five lines pushes Memory off the card.
		const preview = assistantCard(page).getByTestId(
			"personal-instructions-preview",
		);
		await expect(preview).toHaveCSS("white-space", "nowrap");
		const truncated = await preview.evaluate(
			(el) => el.scrollWidth > el.clientWidth + 1,
		);
		expect(truncated).toBe(true);
	});

	test("stacks the cards, ends on the danger card, and never scrolls sideways", async ({
		page,
	}) => {
		await openSettings(page);

		let previousBottom = -1;
		for (const title of CARD_TITLES) {
			const box = await cardBox(page, title);
			if (!box) throw new Error(`${title} did not lay out`);
			// One column: each card starts below the previous one.
			expect(box.y).toBeGreaterThan(previousBottom - 1);
			previousBottom = box.y + box.height;
			expect(box.x + box.width).toBeLessThanOrEqual(391);
		}

		const overflow = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
		}));
		expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
	});

	test("offers a four-chip jump-list that scrolls to a card and hides nothing", async ({
		page,
	}) => {
		await openSettings(page);

		const nav = page.getByRole("navigation", { name: "Jump to a section" });
		await expect(nav).toBeVisible();
		const chips = nav.getByRole("link");
		await expect(chips).toHaveCount(4);

		// Every chip is a 44px target.
		for (const chip of await chips.all()) {
			const box = await chip.boundingBox();
			if (!box) throw new Error("Chip did not lay out");
			expect(box.height).toBeGreaterThanOrEqual(44);
		}

		// Jumping is a shortcut, not a filter: the card it skips past is still
		// on the page before AND after the jump.
		await expect(
			page.getByRole("heading", { name: "Data & privacy", exact: true }),
		).toBeAttached();
		await chips.nth(3).click();
		await expect(
			page.getByRole("heading", { name: "Data & privacy", exact: true }),
		).toBeInViewport({ timeout: 5000 });
		await expect(
			page.getByRole("heading", { name: "Your account", exact: true }),
		).toBeAttached();
	});

	test("every control in the identity card is at least 44px tall", async ({
		page,
	}) => {
		await openSettings(page);

		for (const target of [
			page.getByTestId("account-save"),
			page.getByTestId("account-discard"),
			page.getByRole("textbox", { name: "Display Name" }),
			page.getByLabel("Current password"),
		]) {
			const box = await target.boundingBox();
			if (!box) throw new Error("Control did not lay out");
			expect(box.height).toBeGreaterThanOrEqual(44);
		}

		const seg = page
			.getByRole("group", { name: "Appearance" })
			.getByRole("button")
			.first();
		const segBox = await seg.boundingBox();
		if (!segBox) throw new Error("Segmented option did not lay out");
		expect(segBox.height).toBeGreaterThanOrEqual(44);
	});
});
