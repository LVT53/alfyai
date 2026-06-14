import * as fs from "node:fs";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login } from "./helpers";

const EVIDENCE_DIR = ".sisyphus/evidence";

if (!fs.existsSync(EVIDENCE_DIR)) {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

const VIEWPORTS = {
	mobile: { width: 375, height: 667, name: "mobile" },
	tablet: { width: 768, height: 1024, name: "tablet" },
	desktop: { width: 1280, height: 800, name: "desktop" },
};

async function captureScreenshot(
	page: Page,
	pageName: string,
	viewportName: string,
	suffix: string = "",
) {
	const filename = `task-12-responsive-${pageName}-${viewportName}${suffix ? `-${suffix}` : ""}.png`;
	const filepath = path.join(EVIDENCE_DIR, filename);
	await page.screenshot({ path: filepath, fullPage: true });
	return filepath;
}

async function hasHorizontalScrollbar(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		return (
			document.documentElement.scrollWidth >
			document.documentElement.clientWidth
		);
	});
}

test.describe("Responsive Design Verification - Task 12", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test.describe("Knowledge Page - Library Tab", () => {
		for (const [_key, viewport] of Object.entries(VIEWPORTS)) {
			test(`Library tab at ${viewport.name} (${viewport.width}px)`, async ({
				page,
			}) => {
				await page.setViewportSize({
					width: viewport.width,
					height: viewport.height,
				});
				await page.goto("/knowledge");
				await page.waitForLoadState("networkidle");
				await expect(page.locator("h1")).toContainText("Knowledge Base", {
					timeout: 10000,
				});

				const screenshotPath = await captureScreenshot(
					page,
					"knowledge-library",
					viewport.name,
				);
				const hasScrollbar = await hasHorizontalScrollbar(page);

				expect(
					hasScrollbar,
					`Horizontal scrollbar detected at ${viewport.name}`,
				).toBe(false);
				await expect(
					page.getByRole("heading", { name: "Documents" }),
				).toBeVisible();
				await expect(
					page.getByRole("heading", { name: "Results" }),
				).toBeVisible();
				await expect(
					page.getByRole("heading", { name: "Workflows" }),
				).toBeVisible();

				console.log(
					`✓ Knowledge Library - ${viewport.name}: ${screenshotPath}`,
				);
			});
		}
	});

	test.describe("Knowledge Page - Memory Profile Tab", () => {
		for (const [_key, viewport] of Object.entries(VIEWPORTS)) {
			test(`Memory Profile tab at ${viewport.name} (${viewport.width}px)`, async ({
				page,
			}) => {
				await page.setViewportSize({
					width: viewport.width,
					height: viewport.height,
				});
				await page.goto("/knowledge");
				await page.waitForLoadState("networkidle");

				const memoryTab = page.locator("button", { hasText: "Memory Profile" });
				await memoryTab.click();
				await expect(
					page.getByRole("heading", { name: "Memory Overview" }),
				).toBeVisible({ timeout: 10000 });

				const screenshotPath = await captureScreenshot(
					page,
					"knowledge-memory",
					viewport.name,
				);
				const hasScrollbar = await hasHorizontalScrollbar(page);

				expect(
					hasScrollbar,
					`Horizontal scrollbar detected at ${viewport.name}`,
				).toBe(false);
				await expect(page.locator("text=What feeds this")).toBeVisible();
				await expect(page.locator("text=How it is used")).toBeVisible();

				console.log(`✓ Knowledge Memory - ${viewport.name}: ${screenshotPath}`);
			});
		}
	});

	test.describe("Home Page Chat Interface", () => {
		for (const [_key, viewport] of Object.entries(VIEWPORTS)) {
			test(`Home page at ${viewport.name} (${viewport.width}px)`, async ({
				page,
			}) => {
				await page.setViewportSize({
					width: viewport.width,
					height: viewport.height,
				});

				await page.goto("/");
				await page.waitForLoadState("networkidle");

				await expect(page.locator('[data-testid="message-input"]')).toBeVisible(
					{ timeout: 10000 },
				);

				const screenshotPath = await captureScreenshot(
					page,
					"home-chat",
					viewport.name,
				);
				const hasScrollbar = await hasHorizontalScrollbar(page);

				expect(hasScrollbar, `Horizontal scrollbar at ${viewport.name}`).toBe(
					false,
				);
				await expect(page.getByTestId("send-button")).toBeVisible();

				console.log(`✓ Home Chat - ${viewport.name}: ${screenshotPath}`);
			});
		}
	});

	test("320px minimum width readability", async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 });

		await page.goto("/knowledge");
		await page.waitForLoadState("networkidle");
		await expect(page.locator("h1")).toContainText("Knowledge Base", {
			timeout: 10000,
		});

		const hasScrollbar = await hasHorizontalScrollbar(page);
		expect(hasScrollbar, `Horizontal scrollbar at 320px`).toBe(false);

		console.log("✓ 320px minimum width test passed");
	});
});
