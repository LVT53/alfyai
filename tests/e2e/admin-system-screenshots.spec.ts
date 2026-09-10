import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

// Visual capture of the redesigned admin System screen, both themes. Not an
// assertion suite: it exists so a change to this screen can be reviewed as
// pictures. Skipped unless ADMIN_SYSTEM_SHOTS=1, since it writes files.
const OUT = process.env.ADMIN_SYSTEM_SHOTS_DIR ?? "test-results/admin-system";

// The shared `login` helper waits for the chat composer to become enabled,
// which needs a reachable model. This screen has nothing to do with chat, so it
// signs in and goes straight to Settings.
async function signIn(page: Page) {
	await page.goto("/login", { waitUntil: "domcontentloaded" });
	const result = await page.evaluate(
		async (credentials) => {
			const response = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(credentials),
			});
			return { ok: response.ok, status: response.status };
		},
		{
			email: process.env.E2E_EMAIL ?? "admin@local",
			password: process.env.E2E_PASSWORD ?? "admin123",
		},
	);
	expect(result.ok, `Login failed with status ${result.status}`).toBe(true);
}

const PAGES = [
	"general",
	"models",
	"aiTasks",
	"integrations",
	"limits",
	"skills",
	"advanced",
	"diagnostics",
] as const;

test.describe(() => {
	test.skip(
		process.env.ADMIN_SYSTEM_SHOTS !== "1",
		"set ADMIN_SYSTEM_SHOTS=1 to capture",
	);

	// The app paints dark from a `.dark` class on <html> (stores/theme.ts).
	async function setTheme(page: Page, theme: "light" | "dark") {
		await page.evaluate((next) => {
			document.documentElement.classList.toggle("dark", next === "dark");
			try {
				localStorage.setItem("theme", next);
			} catch {
				// A blocked storage is fine; the class is what paints.
			}
		}, theme);
	}

	test("captures every System page in light and dark", async ({ page }) => {
		mkdirSync(OUT, { recursive: true });
		await page.setViewportSize({ width: 1500, height: 1100 });
		await signIn(page);
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.getByRole("tab", { name: "Administration" }).click();
		await expect(page.getByTestId("admin-system-screen")).toBeVisible();

		for (const theme of ["light", "dark"] as const) {
			await setTheme(page, theme);
			for (const id of PAGES) {
				await page.getByTestId(`system-nav-${id}`).click();
				// Tab state survives a page switch, so the dark pass would
				// otherwise re-photograph whatever tab the light pass left open.
				if (id === "diagnostics") {
					await page.getByRole("tab", { name: "Tool health" }).click();
				}
				if (id === "aiTasks") {
					await page.getByRole("tab", { name: "Models per task" }).click();
				}
				await page.waitForTimeout(350);
				await page.screenshot({
					path: `${OUT}/system-${id}-${theme}.png`,
					fullPage: true,
				});
			}

			// The Atlas card's other tabs, and the two dialogs.
			await page.getByTestId("system-nav-aiTasks").click();
			for (const tab of ["Worker & limits", "Research depth", "Pipeline"]) {
				await page.getByRole("tab", { name: tab }).click();
				await page.waitForTimeout(200);
				await page.screenshot({
					path: `${OUT}/system-aiTasks-${tab.split(" ")[0].toLowerCase()}-${theme}.png`,
					fullPage: true,
				});
			}

			await page.getByTestId("system-nav-diagnostics").click();
			for (const tab of ["Effective configuration", "Routing coverage"]) {
				await page.getByRole("tab", { name: tab }).click();
				await page.waitForTimeout(250);
				await page.screenshot({
					path: `${OUT}/system-diagnostics-${tab.split(" ")[0].toLowerCase()}-${theme}.png`,
					fullPage: true,
				});
			}

			await page.getByTestId("system-nav-models").click();
			await page.getByRole("button", { name: "Add provider" }).click();
			// Long enough for the dialog's backdrop fade to finish, or the shot
			// catches the page mid-wash.
			await page.waitForTimeout(700);
			await page.screenshot({
				path: `${OUT}/system-provider-dialog-${theme}.png`,
			});
			await page.getByRole("button", { name: "Cancel" }).first().click();

			await page.getByTestId("system-nav-skills").click();
			await page.getByRole("button", { name: "New skill" }).click();
			await page.waitForTimeout(700);
			await page.screenshot({
				path: `${OUT}/system-skill-dialog-${theme}.png`,
			});
			await page.getByRole("button", { name: "Cancel" }).first().click();

			// The save bar with something pending, and the guard that catches a
			// navigation away from it.
			await page.getByTestId("system-nav-limits").click();
			await page.locator("#MAX_MESSAGE_LENGTH").fill("31000");
			await page.waitForTimeout(200);
			await page.screenshot({
				path: `${OUT}/system-save-bar-pending-${theme}.png`,
				fullPage: true,
			});

			await page.getByRole("button", { name: "New chat" }).click();
			await page.waitForTimeout(700);
			await page.screenshot({
				path: `${OUT}/system-leave-guard-${theme}.png`,
			});
			await page.getByRole("button", { name: "Keep editing" }).click();
			await page.getByRole("button", { name: "Discard" }).first().click();
		}
	});
});
