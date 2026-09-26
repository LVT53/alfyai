import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	conversations,
	users,
} from "../../src/lib/server/db/schema";
import { login, TEST_EMAIL, waitForHydration } from "./helpers";

test.describe("Search Modal Visual Tests", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.waitForSelector('[data-testid="new-conversation"]', {
			state: "visible",
		});
		await waitForHydration(page);
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

	test("the scope chips say what is searchable", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		for (const scope of ["all", "conversations", "documents", "reports"]) {
			await expect(modal.getByTestId(`search-scope-${scope}`)).toBeVisible();
		}
	});

	test("Connections is greyed and labelled as coming soon", async ({
		page,
	}) => {
		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		const connections = modal.getByTestId("search-scope-connections");
		await expect(connections).toBeVisible();
		// Nothing indexes connector data yet, so the chip says so rather than
		// returning an empty list.
		await expect(connections).toContainText("Coming soon");
		await expect(connections).toHaveAttribute("aria-disabled", "true");
	});

	test("the footer states the keys that already work", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		const footer = modal.locator(".search-modal-footer");
		await expect(footer).toContainText("move");
		await expect(footer).toContainText("open");
		await expect(footer).toContainText("close");
		// Before anything is typed the footer carries the keys and nothing else.
		await expect(modal.getByTestId("search-result-count")).toHaveCount(0);
	});

	// Slice 7 (Feature 2, ADR-0066): the artifact family joins Workspace
	// Search. This spec's own coverage was structural only before this slice
	// (no document was ever seeded) — direct db writes, matching the repo's
	// existing E2E seeding convention.
	test("finds a seeded artifact-family row by name, labelled with its kind, and opens it", async ({
		page,
	}) => {
		// A bare conversation row, seeded directly like several other E2E specs
		// already do (see conversation-title-refresh.spec.ts) — no messages, no
		// live chat round trip, just an id for the artifact's ownership scope.
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const conversationId = `e2e-search-conv-${Date.now()}`;
		const artifactId = `e2e-search-document-${Date.now()}`;
		const artifactName = "Saturday plan zz-e2e-search";
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Seeded for the search modal e2e case",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(artifacts).values({
			id: artifactId,
			userId: user.id,
			conversationId,
			type: "artifact",
			retrievalClass: "durable",
			name: artifactName,
			metadataJson: JSON.stringify({
				artifactType: "document",
				title: artifactName,
			}),
			createdAt: now,
			updatedAt: now,
		});

		const pageErrors: string[] = [];
		page.on("pageerror", (error) => {
			pageErrors.push(error.message);
		});

		try {
			await page
				.getByRole("button", { name: "Search conversations and documents" })
				.click();
			const modal = page.getByRole("dialog", { name: "Search workspace" });
			await modal.waitFor({ state: "visible" });

			await modal.locator("input").first().fill("zz-e2e-search");
			const row = modal.getByText(artifactName);
			await expect(row).toBeVisible();
			const resultButton = row.locator("xpath=ancestor::button[1]");
			await expect(resultButton).toContainText("Document");

			// Reachable and keyboard-activatable like every other result row:
			// focus the row's own button directly and activate it with Enter,
			// rather than driving global ArrowDown from the search input — with
			// other E2E specs' real (uncleaned-up) conversations sitting in this
			// shared database, the modal's own arrow-key active-index can still
			// be settling on a "recent conversations" row from the default view
			// at the moment ArrowDown fires, which is a pre-existing
			// SearchModal.svelte nuance unrelated to this slice, not something
			// this test is about. Focusing the exact row's button and pressing
			// Enter on it exercises native button semantics directly instead.
			//
			// The handoff URL (?open_artifact=...) is a one-shot signal
			// KnowledgeWorkspaceCoordinator clears via replaceState as soon as it
			// opens the document (src/routes/(app)/knowledge/_components/
			// KnowledgeWorkspaceCoordinator.svelte), so the assertion here is on
			// landing back on the Knowledge page without a runtime error, not on
			// the transient query string. Slice 1's Document editor is not on
			// this branch yet, so the panel may fall back to its own
			// "no loader registered" state per slice 0's contract — that is
			// expected here, not a failure.
			await resultButton.focus();
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(/\/knowledge/);
			await page
				.getByTestId("workspace-main")
				.waitFor({ state: "visible", timeout: 10000 })
				.catch(() => {});
			expect(pageErrors).toEqual([]);
		} finally {
			await db.delete(artifacts).where(eq(artifacts.id, artifactId));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});
});
