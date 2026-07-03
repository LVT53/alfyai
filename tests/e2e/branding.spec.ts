import { expect, test } from "@playwright/test";
import { ensureSidebarExpanded, login } from "./helpers";

// ADR 0043 — Slice 13: LogoMark placement on 5 surfaces (+ favicon link).
// These assertions guard that the EXISTING LogoMark (unchanged) now appears
// in the sidebar header, the collapsed sidebar rail, the empty conversation
// state, and the mobile header. Each mark is wrapped in a stable testid span.

test.describe("Brand LogoMark placement (Slice 13)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("sidebar header shows the LogoMark beside the wordmark", async ({
		page,
	}) => {
		await ensureSidebarExpanded(page);
		const logo = page.getByTestId("sidebar-logo");
		await expect(logo).toBeVisible();
		// The mark renders an inline SVG.
		await expect(logo.locator("svg")).toBeVisible();
	});

	test("collapsed sidebar rail shows the LogoMark", async ({ page }) => {
		await ensureSidebarExpanded(page);
		const collapseButton = page.getByRole("button", {
			name: "Collapse sidebar",
		});
		await collapseButton.click();
		// Once collapsed, the mark should still render (as the rail icon).
		await expect(page.getByTestId("sidebar-logo")).toBeVisible();
	});

	test("empty conversation state shows a static LogoMark centerpiece", async ({
		page,
	}) => {
		// The MessageArea empty state (`.conversation-empty-state`) renders on a
		// conversation view with zero messages, not on the "/" landing page. Create
		// an empty conversation via the API and open it.
		const response = await page.request.post("/api/conversations", {
			data: { title: "Slice 13 empty state" },
		});
		expect(response.ok(), "create empty conversation").toBe(true);
		const conversation = (await response.json()) as { id: string };
		await page.goto(`/chat/${conversation.id}`, {
			waitUntil: "domcontentloaded",
		});

		const emptyLogo = page.getByTestId("empty-state-logo");
		await expect(emptyLogo).toBeVisible();
		// Static (non-animated): the SVG must not contain the draw animation keyframes.
		const hasAnimation = await emptyLogo.locator("svg style").count();
		expect(hasAnimation).toBe(0);
	});
});

test.describe("Mobile header brand mark (Slice 13)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("mobile header shows the LogoMark on a mobile viewport", async ({
		page,
	}) => {
		// Header is lg:hidden; force a mobile viewport so it renders.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/", { waitUntil: "domcontentloaded" });
		const mobileLogo = page.getByTestId("mobile-header-logo");
		await expect(mobileLogo).toBeVisible();
		await expect(mobileLogo.locator("svg")).toBeVisible();
	});
});
