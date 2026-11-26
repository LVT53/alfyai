import { expect, test } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	conversations,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import type { WorkspaceSearchResponse } from "../../src/lib/server/services/workspace-search/types";
import { emptyCanvasBody } from "../../src/lib/shared/artifacts/canvas-body";
import { DEFAULT_CONVERSATION_TITLE } from "../../src/lib/shared/conversation-title";
import { seedCanvas } from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { seedImageItem } from "./artifact-tours-helpers";
import { login, TEST_EMAIL, waitForHydration } from "./helpers";

// RC-A new #9 (FX-1 item 6): a chat nobody has named yet is stored as the English
// default, and every surface prints the reader's own language for it ("Új
// beszélgetés"); the search modal still printed the stored sentence. Only the
// Hungarian UI shows it (the English label is the stored default itself).
test.describe("Search Modal untitled conversations", () => {
	test("an untitled conversation reads 'Új beszélgetés' in a Hungarian reader's results", async ({
		page,
	}) => {
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const conversationId = `e2e-search-untitled-${Date.now()}`;
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: DEFAULT_CONVERSATION_TITLE,
			createdAt: now,
			updatedAt: now,
		});
		// What the reader asked, which is what finds a chat nobody has named.
		await db.insert(messages).values({
			id: `${conversationId}-q`,
			conversationId,
			messageSequence: 1,
			role: "user",
			content: "Szombati programtippek zz-e2e-untitled bécsi hétvégére",
			createdAt: now,
		});
		await db
			.update(users)
			.set({ uiLanguage: "hu" })
			.where(eq(users.email, TEST_EMAIL));
		try {
			await login(page);
			await waitForHydration(page);
			await page
				.getByRole("button", {
					name: "Keresés a beszélgetésekben, az emlékekben, a dokumentumokban és máshol",
				})
				.click();
			const modal = page.getByRole("dialog", { name: "Munkaterület keresése" });
			await modal.waitFor({ state: "visible" });

			await modal.locator("input").first().fill("zz-e2e-untitled");
			// The untitled chat is found by what was asked in it, and named in the
			// reader's own words, never by the stored English sentence.
			const result = modal.getByRole("button", { name: /zz-e2e-untitled/ });
			await expect(result).toBeVisible();
			await expect(result).toContainText("Új beszélgetés");
			await expect(result).not.toContainText(DEFAULT_CONVERSATION_TITLE);
		} finally {
			await db
				.update(users)
				.set({ uiLanguage: "en" })
				.where(eq(users.email, TEST_EMAIL));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});
});

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
			.getByRole("button", { name: "Search chats, memory, documents and more" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });
		// A query that matches nothing makes the results area a deterministic empty state:
		// at rest the modal is as tall as the conversations and documents earlier tests left
		// in this database make it (see the screenshot tests below), and a list that fills it
		// puts its top at 44 px, which is where a centered modal of that height belongs.
		await modal.locator("input").first().fill("zzz-no-such-result-xyz");
		await page.waitForTimeout(600);

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

	test("search modal stays centered when its list is full", async ({
		page,
	}) => {
		// Three recent conversations and three recent documents are what the modal lists at
		// rest, which with its headings and footer is the most it grows: nearly the window.
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const stamp = Date.now();
		const conversationIds = [0, 1, 2].map(
			(index) => `e2e-search-full-${stamp}-${index}`,
		);
		const now = new Date();
		const artifactIds: string[] = [];
		try {
			for (const [index, id] of conversationIds.entries()) {
				await db.insert(conversations).values({
					id,
					userId: user.id,
					title: `Search modal fill ${index}`,
					createdAt: now,
					updatedAt: now,
				});
				await db.insert(messages).values({
					id: `${id}-q`,
					conversationId: id,
					messageSequence: 1,
					role: "user",
					content: `Something to find ${index}`,
					createdAt: now,
				});
				artifactIds.push(
					await seedCanvas(
						id,
						emptyCanvasBody(),
						`Search modal board ${index}`,
					),
				);
			}
			await page.reload({ waitUntil: "networkidle" });
			await waitForHydration(page);
			await page
				.getByRole("button", {
					name: "Search chats, memory, documents and more",
				})
				.click();
			const modal = page.getByRole("dialog", { name: "Search workspace" });
			await modal.waitFor({ state: "visible" });
			await expect(modal.getByText("Search modal board 0")).toBeVisible();
			await page.waitForTimeout(600);

			const box = await modal.boundingBox();
			const viewport = page.viewportSize();
			if (!box || !viewport) throw new Error("the modal is not on screen");
			// The list is full: the modal is most of the window tall...
			expect(box.height).toBeGreaterThan(viewport.height * 0.8);
			// ...and centered in it: the same room above and below, and the same left and right.
			expect(
				Math.abs(box.y - (viewport.height - (box.y + box.height))),
			).toBeLessThan(2);
			expect(
				Math.abs(box.x - (viewport.width - (box.x + box.width))),
			).toBeLessThan(2);
			expect(box.y).toBeGreaterThanOrEqual(16);
		} finally {
			await db.delete(artifacts).where(inArray(artifacts.id, artifactIds));
			await db
				.delete(conversations)
				.where(inArray(conversations.id, conversationIds));
		}
	});

	test("search modal has correct z-index above sidebar", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search chats, memory, documents and more" })
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
			.getByRole("button", { name: "Search chats, memory, documents and more" })
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
			.getByRole("button", { name: "Search chats, memory, documents and more" })
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
			.getByRole("button", { name: "Search chats, memory, documents and more" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		await page.keyboard.press("Escape");

		await modal.waitFor({ state: "hidden" });
	});

	test("search modal closes on backdrop click", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search chats, memory, documents and more" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		const backdrop = page.locator(".search-portal-backdrop");
		await backdrop.click({ position: { x: 10, y: 10 } });

		await modal.waitFor({ state: "hidden" });
	});

	test("search input is focused when modal opens", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search chats, memory, documents and more" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		const searchInput = modal.locator('input[type="text"]');
		await expect(searchInput).toBeFocused();
	});

	test("the scope chips say what is searchable", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search chats, memory, documents and more" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });

		for (const scope of ["all", "chats", "documents", "media", "apps"]) {
			await expect(modal.getByTestId(`search-scope-${scope}`)).toBeVisible();
		}
		await expect(modal.getByTestId("search-scope-chats")).toContainText(
			"Chats",
		);
		await expect(modal.getByTestId("search-scope-media")).toContainText(
			"Pictures & videos",
		);
		// The shared admin is not on native Memory, so there is nothing to search
		// there and no Memory chip.
		await expect(modal.getByTestId("search-scope-memory")).toHaveCount(0);
	});

	test("an empty kind's chip looks unavailable and does not light up", async ({
		page,
	}) => {
		await page
			.getByRole("button", { name: "Search chats, memory, documents and more" })
			.click();
		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });
		await modal.locator("input").first().fill("zzz-no-such-result-xyz");

		const apps = modal.getByTestId("search-scope-apps");
		await expect(apps).toHaveAttribute("aria-disabled", "true");
		await expect(apps).toHaveCSS("opacity", "0.5");
		await expect(apps).toHaveCSS("cursor", "default");
		await apps.hover();
		const all = modal.getByTestId("search-scope-all");
		// Hovered, it keeps its muted words: only a chip that does something lights up.
		expect(
			await apps.evaluate((chip) => getComputedStyle(chip).color),
		).not.toBe(await all.evaluate((chip) => getComputedStyle(chip).color));
		await expect(all).not.toHaveAttribute("aria-disabled");
	});

	test("draws no Connections chip", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search chats, memory, documents and more" })
			.click();

		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });
		await expect(modal.getByTestId("search-scope-all")).toBeVisible();

		// Nothing indexes connections, so there is no chip for them, greyed or not.
		await expect(modal.getByTestId("search-scope-connections")).toHaveCount(0);
		await expect(modal.getByText("Connections")).toHaveCount(0);
		await expect(modal.getByText("Coming soon")).toHaveCount(0);
	});

	test("the chip labels are Hungarian in a Hungarian interface", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		try {
			await page.reload({ waitUntil: "networkidle" });
			await waitForHydration(page);
			await page
				.getByRole("button", {
					name: "Keresés a beszélgetésekben, az emlékekben, a dokumentumokban és máshol",
				})
				.click();
			const modal = page.getByRole("dialog", { name: "Munkaterület keresése" });
			await modal.waitFor({ state: "visible" });

			await expect(modal.getByTestId("search-scope-all")).toContainText("Mind");
			await expect(modal.getByTestId("search-scope-chats")).toContainText(
				"Beszélgetések",
			);
			await expect(modal.getByTestId("search-scope-documents")).toContainText(
				"Dokumentumok",
			);
			await expect(modal.getByTestId("search-scope-media")).toContainText(
				"Képek és videók",
			);
			await expect(modal.getByTestId("search-scope-apps")).toContainText(
				"Alkalmazások",
			);
			await expect(modal.getByTestId("search-scope-connections")).toHaveCount(
				0,
			);
		} finally {
			await setUiLanguage("en");
		}
	});

	test("a memory result opens its entry in Memory and leaves the address at ?tab=memory", async ({
		page,
	}) => {
		const entryText = "You own a green touring kayak and a white racing kayak.";
		const lastSaidAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
		const ref = {
			scope: { kind: "personal" },
			generation: "g1",
			rowId: "kayak",
		} as const;
		const row = { ref, text: entryText, updatedAt: lastSaidAt, sourceCount: 1 };
		const answer: WorkspaceSearchResponse = {
			query: "kayak",
			mode: "query",
			scope: "all",
			conversations: [],
			memories: [
				{
					id: "kayak",
					scope: { kind: "personal" },
					projectName: null,
					text: entryText,
					lastSaidAt,
					href: "/knowledge?tab=memory&memoryScope=personal&memoryEntry=kayak&memoryQuery=kayak",
				},
			],
			documents: [],
			totals: { chats: 0, memory: 1, documents: 0, media: 0, apps: 0 },
			memorySearchable: true,
			nextCursor: null,
		};
		await page.route("**/api/workspace-search*", async (route) => {
			const query = new URL(route.request().url()).searchParams.get("q") ?? "";
			await route.fulfill({
				json: query
					? answer
					: {
							...answer,
							mode: "default",
							query: "",
							memories: [],
							totals: { ...answer.totals, memory: 0 },
						},
			});
		});
		// The Memory view's own reads, as memory-replacement.spec.ts stubs them: no
		// real native account is made, so nothing leaks into later specs.
		await page.route("**/api/knowledge/memory?*", (route) =>
			route.fulfill({
				json: {
					authority: "hindsight",
					scope: ref.scope,
					generation: "g1",
					rows: [row],
					nextCursor: null,
					total: 1,
					status: "ready",
				},
			}),
		);
		await page.route("**/api/knowledge/memory/kayak?*", (route) =>
			route.fulfill({
				json: {
					row,
					sources: [],
					versions: [],
					canEdit: true,
					canRemove: true,
				},
			}),
		);

		await page
			.getByRole("button", { name: "Search chats, memory, documents and more" })
			.click();
		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });
		await modal.locator("input").first().fill("kayak");

		const result = modal.getByRole("button", { name: /green touring kayak/ });
		await expect(result).toBeVisible();
		await expect(result).toContainText("Personal");
		await expect(result).toContainText("said 3 days ago");
		await expect(modal.getByTestId("search-scope-memory")).toContainText("1");

		await result.click();

		await expect(page.getByTestId("memory-detail")).toBeVisible();
		await expect(page.getByTestId("memory-detail")).toContainText(entryText);
		await expect(page).toHaveURL(/\/knowledge\?tab=memory$/);
	});

	test("a picture result shows its thumbnail", async ({ page }) => {
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const conversationId = `e2e-search-picture-${Date.now()}`;
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Cover ideas zz-e2e-chat",
			createdAt: now,
			updatedAt: now,
		});
		const { artifactId } = await seedImageItem(
			{ id: user.id, email: TEST_EMAIL, password: "" },
			conversationId,
			{
				title: "Harbour at dusk",
				decorate: () => ({
					prompt: "zz-e2e-picture lamplight over the harbour",
				}),
			},
		);
		try {
			await page
				.getByRole("button", {
					name: "Search chats, memory, documents and more",
				})
				.click();
			const modal = page.getByRole("dialog", { name: "Search workspace" });
			await modal.waitFor({ state: "visible" });
			await modal.locator("input").first().fill("zz-e2e-picture");

			// Found by the prompt it was made from, under Pictures & videos.
			await expect(modal.getByTestId("search-scope-media")).toContainText("1");
			const row = modal.locator(".search-result-document", {
				hasText: "Harbour at dusk",
			});
			await expect(row).toBeVisible();
			await expect(row).toContainText("Image");
			await expect(row).toContainText("Made in “Cover ideas zz-e2e-chat”");
			await expect(row).toContainText("lamplight over the harbour");
			const thumbnail = row.locator("img");
			await expect(thumbnail).toHaveAttribute(
				"src",
				/\/api\/images\/files\/.+variant=thumb/,
			);
			// The picture itself arrived: the server drew a thumbnail, not a broken link.
			await expect
				.poll(() =>
					thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth),
				)
				.toBeGreaterThan(0);
		} finally {
			await db.delete(artifacts).where(eq(artifacts.id, artifactId));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});

	test("the chosen chip stays in view in the chip row on a phone", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 });
		const answer: WorkspaceSearchResponse = {
			query: "thesis",
			mode: "query",
			scope: "all",
			conversations: [],
			memories: [],
			documents: [],
			totals: { chats: 12, memory: 3, documents: 20, media: 30, apps: 8 },
			memorySearchable: true,
			nextCursor: null,
		};
		await page.route("**/api/workspace-search*", async (route) => {
			const params = new URL(route.request().url()).searchParams;
			await route.fulfill({
				json: params.get("q")
					? { ...answer, scope: params.get("scope") ?? "all" }
					: { ...answer, mode: "default", query: "" },
			});
		});

		await page.keyboard.press("ControlOrMeta+k");
		const modal = page.getByRole("dialog", { name: "Search workspace" });
		await modal.waitFor({ state: "visible" });
		await modal.locator("input").first().fill("thesis");
		const chips = modal.locator(".search-scope-row");
		const apps = modal.getByTestId("search-scope-apps");
		// The answer has arrived: Apps carries its count, so the chip can be chosen.
		await expect(apps).toContainText("8");

		const within = async () => {
			const row = await chips.boundingBox();
			const chip = await apps.boundingBox();
			if (!row || !chip) throw new Error("the chip row is not on screen");
			return {
				row,
				chip,
				inside:
					chip.x >= row.x - 1 && chip.x + chip.width <= row.x + row.width + 1,
			};
		};
		// The row scrolls sideways: Apps, the last chip, starts out of sight.
		await expect.poll(async () => (await within()).inside).toBe(false);

		// A DOM click, so Playwright does not scroll the chip into view first: the
		// page has to do it.
		await apps.evaluate((element) => (element as HTMLElement).click());
		await expect(apps).toHaveAttribute("aria-pressed", "true");
		await expect.poll(async () => (await within()).inside).toBe(true);
	});

	test("the footer states the keys that already work", async ({ page }) => {
		await page
			.getByRole("button", { name: "Search chats, memory, documents and more" })
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
	test("finds a seeded artifact-family row by name, labelled with its kind, and opens it", {
		tag: "@smoke",
	}, async ({ page }) => {
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
				.getByRole("button", {
					name: "Search chats, memory, documents and more",
				})
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
