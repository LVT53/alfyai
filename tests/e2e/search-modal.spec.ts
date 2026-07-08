import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("Search Modal Visual Tests", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.waitForSelector('[data-testid="new-conversation"]', {
			state: "visible",
		});
	});

	test("search modal appears centered in viewport", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		const box = await modal.boundingBox();
		const viewport = page.viewportSize();

		if (box && viewport) {
			const modalCenterX = box.x + box.width / 2;
			const viewportCenterX = viewport.width / 2;

			expect(Math.abs(modalCenterX - viewportCenterX)).toBeLessThan(100);
			expect(box.y).toBeGreaterThan(50);
			expect(box.y).toBeLessThan(viewport.height * 0.3);
		}
	});

	test("search modal has correct z-index above sidebar", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		const backdrop = page.locator(".search-portal-backdrop");
		await expect(backdrop).toBeVisible();

		const zIndex = await backdrop.evaluate(
			(el) => window.getComputedStyle(el).zIndex,
		);
		expect(parseInt(zIndex, 10)).toBeGreaterThanOrEqual(100);
	});

	test("search modal renders correctly in light mode", async ({ page }) => {
		await page.evaluate(() => {
			localStorage.setItem("theme", "light");
			document.documentElement.classList.remove("dark");
		});

		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });
		// Type a query that matches nothing so the results area is a deterministic
		// empty state — otherwise the modal height varies with ambient
		// conversations/documents left by earlier tests and the snapshot flakes.
		await modal.locator("input").first().fill("zzz-no-such-result-xyz");
		await page.waitForTimeout(600);

		await expect(modal).toHaveScreenshot("search-modal-light.png", {
			maxDiffPixels: 100,
			maxDiffPixelRatio: 0.03,
		});
	});

	test("search modal renders correctly in dark mode", async ({ page }) => {
		await page.evaluate(() => {
			localStorage.setItem("theme", "dark");
		});

		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });
		await page.evaluate(() => {
			document.documentElement.classList.add("dark");
		});
		await page.waitForFunction(
			() =>
				getComputedStyle(document.body).backgroundColor === "rgb(26, 26, 26)",
		);
		// Deterministic empty-results state (see light-mode test).
		await modal.locator("input").first().fill("zzz-no-such-result-xyz");
		await page.waitForTimeout(600);

		await expect(modal).toHaveScreenshot("search-modal-dark.png", {
			maxDiffPixels: 100,
			maxDiffPixelRatio: 0.03,
		});

		await page.evaluate(() => {
			localStorage.setItem("theme", "light");
			document.documentElement.classList.remove("dark");
		});
	});

	test("search modal closes on escape key", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		await page.keyboard.press("Escape");

		await modal.waitFor({ state: "hidden" });
	});

	test("search modal closes on backdrop click", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		const backdrop = page.locator(".search-portal-backdrop");
		await backdrop.click({ position: { x: 10, y: 10 } });

		await modal.waitFor({ state: "hidden" });
	});

	test("search input is focused when modal opens", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		const searchInput = modal.locator('input[type="text"]');
		await expect(searchInput).toBeFocused();
	});
});
