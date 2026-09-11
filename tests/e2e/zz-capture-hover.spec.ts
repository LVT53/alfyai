import { mkdirSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";

// Visual capture for the hover-affordance audit: it hovers one representative
// element per redesigned surface and photographs it in both themes, so a
// square fill on a rounded row is visible to the eye rather than only inferred
// from the CSS.
//
// It asserts nothing CI needs and writes files, so it SKIPS unless
// HOVER_CAPTURE=1. It stays a .spec.ts under tests/e2e so it keeps compiling
// against the same helpers and is type-checked with everything else.
//
//   HOVER_CAPTURE=1 E2E_PORT=5202 npx playwright test tests/e2e/zz-capture-hover.spec.ts

const OUT =
	process.env.HOVER_SHOTS_DIR ??
	"/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/dc2da4d4-d513-4098-9b2b-8b6c426191eb/scratchpad/everyday-redesign/hover-audit";

test.describe(() => {
	test.skip(
		process.env.HOVER_CAPTURE !== "1",
		"set HOVER_CAPTURE=1 to capture",
	);

	// The shared `login` helper waits for the chat composer to become enabled,
	// which needs a reachable model. Nothing here touches chat.
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

	/**
	 * Hover `target` and photograph a padded crop around it. The padding is what
	 * makes the defect legible: a fill that runs past the element's rounded
	 * corners only shows against the surface beside it.
	 */
	async function shoot(
		page: Page,
		target: Locator,
		name: string,
		theme: string,
	) {
		// A surface may legitimately have nothing to show (no connections yet, an
		// empty search). Capture what is there and move on rather than failing
		// the whole run.
		const visible = target.filter({ visible: true });
		if ((await visible.count()) === 0) {
			console.log(`[hover-capture] SKIP ${name} (${theme}) — nothing visible`);
			return;
		}
		const el = visible.first();
		let box: { x: number; y: number; width: number; height: number } | null;
		try {
			await el.scrollIntoViewIfNeeded({ timeout: 5000 });
			await page.waitForTimeout(150);
			await el.hover({ force: true, timeout: 5000 });
			// Let the 150ms ease finish before the shutter.
			await page.waitForTimeout(350);
			box = await el.boundingBox();
		} catch (err) {
			console.log(
				`[hover-capture] SKIP ${name} (${theme}) — ${(err as Error).message.slice(0, 80)}`,
			);
			return;
		}
		if (!box) {
			console.log(`[hover-capture] SKIP ${name} (${theme}) — no box`);
			return;
		}

		// A still cannot show an ease, and a fill's radius is easier to trust
		// from the computed value than from the pixels. Read both from the
		// element actually painting the fill: for a table row that is the cell.
		const computed = await el.evaluate((node) => {
			const el2 = node as HTMLElement;
			const painter =
				el2.tagName === "TR" ? (el2.querySelector("td") ?? el2) : el2;
			const s = getComputedStyle(painter);
			return {
				on:
					painter.tagName.toLowerCase() +
					(painter.className
						? `.${String(painter.className).split(" ")[0]}`
						: ""),
				duration: s.transitionDuration,
				property: s.transitionProperty,
				timing: s.transitionTimingFunction,
				radius: s.borderRadius,
				background: s.backgroundColor,
			};
		});
		console.log(
			`[hover-style] ${name} (${theme}) on=${computed.on} radius=${computed.radius} transition=${computed.property} ${computed.duration} ${computed.timing} bg=${computed.background}`,
		);
		const pad = 20;
		const viewport = page.viewportSize() ?? { width: 1500, height: 1100 };
		await page.screenshot({
			path: `${OUT}/${name}-${theme}.png`,
			clip: {
				x: Math.max(0, box.x - pad),
				y: Math.max(0, box.y - pad),
				width: Math.min(
					viewport.width - Math.max(0, box.x - pad),
					box.width + pad * 2,
				),
				height: Math.min(
					viewport.height - Math.max(0, box.y - pad),
					box.height + pad * 2,
				),
			},
		});
		console.log(`[hover-capture] wrote ${name}-${theme}.png`);
	}

	async function openAdministration(page: Page) {
		const tabs = page.getByRole("tab");
		const count = await tabs.count();
		for (let i = 0; i < count; i += 1) {
			const label = (await tabs.nth(i).textContent())?.toLowerCase() ?? "";
			if (label.includes("admin")) {
				await tabs.nth(i).click();
				await page.waitForTimeout(600);
				return true;
			}
		}
		return false;
	}

	for (const theme of ["light", "dark"] as const) {
		test(`hover states across the redesigned surfaces (${theme})`, async ({
			page,
		}) => {
			mkdirSync(OUT, { recursive: true });
			await page.setViewportSize({ width: 1500, height: 1100 });
			await signIn(page);

			// ---- Settings › Profile -------------------------------------------
			await page.goto("/settings", { waitUntil: "domcontentloaded" });
			await page.waitForLoadState("networkidle");
			await setTheme(page, theme);
			await page.waitForTimeout(400);

			await shoot(
				page,
				page.locator(".settings-row-link"),
				"01-settings-row",
				theme,
			);
			await shoot(
				page,
				page.locator(".profile-jump-chip"),
				"02-profile-chip",
				theme,
			);

			// ---- Settings › Administration › System ---------------------------
			if (await openAdministration(page)) {
				await shoot(
					page,
					page.locator(".sys-nav-item"),
					"03-sys-nav-item",
					theme,
				);

				// Diagnostics carries the tool-health and effective-config tables:
				// the rows whose hover fill used to be a square band.
				const diagnostics = page.getByTestId("system-nav-diagnostics");
				if ((await diagnostics.count()) > 0) {
					await diagnostics.click();
					await page.waitForTimeout(700);
					await shoot(
						page,
						page.locator(".sys-table tbody tr"),
						"04-sys-table-row",
						theme,
					);
				}

				// Advanced carries the collapsible group headers.
				const advanced = page.getByTestId("system-nav-advanced");
				if ((await advanced.count()) > 0) {
					await advanced.click();
					await page.waitForTimeout(700);
					await shoot(
						page,
						page.locator(".sys-group-head"),
						"05-sys-group-head",
						theme,
					);
					await shoot(
						page,
						page.locator(".sys-list-row"),
						"06-sys-list-row",
						theme,
					);
				}

				// ---- Settings › Administration › Users ------------------------
				const usersTab = page.getByRole("button", { name: /users/i });
				if ((await usersTab.count()) > 0) {
					await usersTab.first().click();
					await page.waitForTimeout(900);
					await shoot(page, page.locator(".user-row"), "07-users-row", theme);
					await shoot(
						page,
						page.locator(".sort-button"),
						"08-users-sort-header",
						theme,
					);
				}
			}

			// ---- Settings › Connections ---------------------------------------
			await page.goto("/settings?section=connections", {
				waitUntil: "domcontentloaded",
			});
			await page.waitForLoadState("networkidle");
			await setTheme(page, theme);
			await page.waitForTimeout(700);
			await shoot(
				page,
				page.locator(".connection-identity"),
				"09-connection-row",
				theme,
			);
			await shoot(
				page,
				page.locator(".provider-card"),
				"10-provider-card",
				theme,
			);

			// ---- The search modal ---------------------------------------------
			await page.goto("/", { waitUntil: "domcontentloaded" });
			await page.waitForLoadState("networkidle");
			await setTheme(page, theme);
			await page.waitForTimeout(500);
			await page.keyboard.press("Control+k");
			await page.waitForTimeout(700);
			await shoot(
				page,
				page.locator(".search-scope-chip"),
				"11-search-scope-chip",
				theme,
			);
			await shoot(
				page,
				page.locator(".search-result-shell"),
				"12-search-result-row",
				theme,
			);
			await page.keyboard.press("Escape");
		});
	}
});
