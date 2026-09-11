// Screenshot capture for the Knowledge visual polish pass. It asserts nothing
// anyone needs CI to assert — it drives the real app with a stubbed memory
// profile and a seeded document library so every state can be photographed in
// both themes at three widths, and writes PNGs to a scratch directory that
// only exists on the machine that made them.
//
// So it SKIPS unless KNOWLEDGE_CAPTURE=1 is set. It stays a .spec.ts in
// tests/e2e/ (rather than moving somewhere Playwright's testDir cannot see) so
// it keeps compiling against the same helpers and gets type-checked with
// everything else; a CI run reports it as skipped rather than trying to write
// to a path it does not have.
//
//   KNOWLEDGE_CAPTURE=1 POLISH_PHASE=after \
//     npx playwright test tests/e2e/zz-knowledge-polish-capture.spec.ts
import { existsSync, mkdirSync } from "node:fs";
import { type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { login, waitForHydration } from "./helpers";

test.skip(
	process.env.KNOWLEDGE_CAPTURE !== "1",
	"screenshot capture helper — set KNOWLEDGE_CAPTURE=1 to run it",
);

const ROOT =
	process.env.POLISH_CAPTURE_DIR ??
	"/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/dc2da4d4-d513-4098-9b2b-8b6c426191eb/scratchpad/everyday-redesign/impl-knowledge-polish";
const PHASE = process.env.POLISH_PHASE ?? "before";
const DIR = `${ROOT}/${PHASE}`;

function ensureDir() {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// memory fixtures — 52 memories over the four categories, needs-review, timeline
// ---------------------------------------------------------------------------
const CATEGORY_SEEDS = {
	about_you: [
		"Runs AlfyAI on a self-hosted machine called alfyroot.",
		"Works mainly on the assistant itself — serving, analytics and Atlas.",
		"Reads and writes in English and Hungarian.",
		"Keeps files in Nextcloud and photos in Immich.",
		"Works to Central European Time.",
		"Is the only administrator on this instance.",
		"Has a daughter who started school in September.",
		"Rides to the office on dry days.",
	],
	preferences: [
		"Wants short answers, with the reasoning left out unless asked for.",
		"Metric units and 24-hour time.",
		"No emoji in written output.",
		"Reads long reports as a PDF rather than in the chat.",
		"Prefers British spelling.",
	],
	goals_ongoing_work: [
		"Shipping the everyday-screens redesign this month.",
		"Owes Kata a reply about the September invoice.",
		"Comparing the two EU battery-rule drafts for an Atlas report.",
		"Moving the photo library off the old NAS before winter.",
		"Wants the Flash-Next rollback written down before the next swap.",
	],
	constraints_boundaries: [
		"Nothing may leave the machine without being asked first.",
		"Never write to Nextcloud outside /AlfyAI and /Documents/Reports.",
		"Do not send email on his behalf — always show the draft.",
		"Immich deletions always need confirming; that server has no trash.",
		"No work suggestions after 19:00 on weekdays.",
	],
} as const;

const CATEGORY_TOTALS = {
	about_you: 23,
	preferences: 14,
	goals_ongoing_work: 9,
	constraints_boundaries: 6,
} as const;

type CategoryKey = keyof typeof CATEGORY_TOTALS;

function buildCategory(category: CategoryKey) {
	const seeds = CATEGORY_SEEDS[category];
	const total = CATEGORY_TOTALS[category];
	return {
		category,
		items: Array.from({ length: total }, (_, index) => {
			const statement =
				index < seeds.length
					? seeds[index]
					: `${seeds[index % seeds.length]} (${index + 1})`;
			const day = ((total - index) % 28) + 1;
			return {
				id: `${category}-${index}`,
				itemKey: `${category}-${index}`,
				category,
				statement,
				scope:
					category === "goals_ongoing_work" && index === 0
						? { type: "project", id: "project-1" }
						: category === "goals_ongoing_work" && index === 2
							? { type: "conversation", id: "conversation-1" }
							: { type: "global" },
				status: "active",
				revision: 1,
				updatedAt: `2026-09-${String(day).padStart(2, "0")}T09:00:00.000Z`,
				confidence: index % 3 === 1 ? "inferred" : "stated",
				expiresAt:
					category === "goals_ongoing_work" && index === 1
						? "2026-09-30T00:00:00.000Z"
						: null,
				canEdit: true,
				canDelete: true,
				canSuppress: true,
			};
		}),
	};
}

const MEMORY_PROFILE = {
	resetGeneration: 1,
	projectionRevision: 42,
	categories: (Object.keys(CATEGORY_TOTALS) as CategoryKey[]).map(
		buildCategory,
	),
	review: {
		openCount: 4,
		overflowCount: 1,
		visibleItems: [
			{
				id: "review-1",
				subject: "About You",
				question: "Did you move to a new flat in August?",
				reason: "Two conversations disagree about where you live.",
				canAccept: true,
				expiresAt: "2026-09-23T00:00:00.000Z",
			},
			{
				id: "review-2",
				subject: "Preferences",
				question: "Merge two memories about your preferred reply length?",
				reason: "They say the same thing in different words.",
				canAccept: true,
				expiresAt: "2026-10-02T00:00:00.000Z",
			},
			{
				id: "review-3",
				subject: "Goals & Ongoing Work",
				question: "Is the battery-rules comparison still open?",
				reason: "Nothing has referred to it for 9 days.",
				canAccept: true,
				expiresAt: "2026-09-16T00:00:00.000Z",
			},
		],
		items: [
			{
				id: "review-4",
				subject: "Constraints & Boundaries",
				question: "Should Immich deletions still always be confirmed?",
				reason: "You confirmed every one of the last twelve.",
				canAccept: true,
				expiresAt: "2026-10-10T00:00:00.000Z",
			},
		],
	},
};

const MEMORY_SUMMARY = {
	summary: {
		text: "You run AlfyAI on your own hardware and you would rather nothing left the machine unless you say so. You work on the assistant itself most days — its serving config, its analytics, its Atlas reports — and you want the reasoning behind a change before it ships. You read short. Metric units, 24-hour time, no emoji, English unless you ask for Hungarian. Long reports go to a PDF rather than into the chat.",
		updatedAt: "2026-09-11T08:00:00.000Z",
	},
};

const MEMORY_TIMELINE = {
	reports: [
		{
			id: "report-1",
			status: "completed",
			summaryText: "Tidied 4 memories — 2 merged, 1 retired, 1 expired.",
			createdAt: "2026-09-11T03:12:00.000Z",
			actions: [
				{
					type: "merged",
					description: "Merged two memories about reply length.",
					resultStatement: "Wants short answers, reasoning left out.",
				},
				{
					type: "expired",
					description: "Retired an expired reminder about the NAS move.",
					resultStatement: null,
				},
			],
		},
		{
			id: "report-2",
			status: "completed",
			summaryText: "Merged 2 duplicates in Preferences.",
			createdAt: "2026-09-09T03:11:00.000Z",
			actions: [],
		},
		{
			id: "report-3",
			status: "completed",
			summaryText: "Nothing to do.",
			createdAt: "2026-09-08T03:10:00.000Z",
			actions: [],
		},
		{
			id: "report-4",
			status: "failed",
			summaryText: "Run failed — the model was unreachable.",
			createdAt: "2026-09-07T03:09:00.000Z",
			actions: [],
		},
	],
};

const MEMORY_OVERVIEW = {
	processing: {
		active: true,
		pendingCount: 1,
		operations: [
			{ reason: "deferred_intake", scope: { type: "global" }, count: 1 },
		],
	},
};

// ---------------------------------------------------------------------------
// documents — nine rows: mixed versions, statuses and types, one very long
// name, one with no normalised version at all.
// ---------------------------------------------------------------------------
const SEED_CONVERSATION_ID = "seed-conversation-atlas";

interface SeedDocument {
	id: string;
	name: string;
	type: string;
	mimeType: string;
	sizeBytes: number;
	ageDays: number;
	metadata: Record<string, unknown> | null;
	conversationId?: string;
}

const SEED_DOCUMENTS: SeedDocument[] = [
	{
		id: "seed-atlas-09",
		name: "atlas-battery-rules-2026-09.pdf",
		type: "generated_output",
		mimeType: "application/pdf",
		sizeBytes: 1_400_000,
		ageDays: 0,
		metadata: {
			documentFamilyId: "family-atlas-sep",
			documentFamilyStatus: "active",
			versionNumber: 3,
			sourceChatFileId: "chat-file-atlas-sep",
		},
		conversationId: SEED_CONVERSATION_ID,
	},
	{
		id: "seed-long-name",
		name: "eu-battery-regulation-2026-comparative-annex-with-member-state-derogations-and-transitional-provisions.pdf",
		type: "generated_output",
		mimeType: "application/pdf",
		sizeBytes: 4_820_000,
		ageDays: 1,
		metadata: {
			documentFamilyId: "family-annex",
			documentFamilyStatus: "active",
			versionNumber: 12,
			sourceChatFileId: "chat-file-annex",
		},
		conversationId: SEED_CONVERSATION_ID,
	},
	{
		id: "seed-reply-tone",
		name: "reply-tone.md",
		type: "skill_note",
		mimeType: "text/markdown",
		sizeBytes: 3_100,
		ageDays: 3,
		metadata: {
			documentFamilyId: "family-tone",
			documentFamilyStatus: "active",
			versionNumber: 2,
		},
	},
	{
		id: "seed-invoice",
		name: "invoice-2026-09.pdf",
		type: "source_document",
		mimeType: "application/pdf",
		sizeBytes: 148_000,
		ageDays: 1,
		metadata: {
			documentFamilyId: "family-invoice",
			documentFamilyStatus: "active",
			versionNumber: 1,
		},
	},
	{
		id: "seed-audit",
		name: "nextcloud-folder-audit.csv",
		type: "source_document",
		mimeType: "text/csv",
		sizeBytes: 22_000,
		ageDays: 2,
		metadata: null,
	},
	{
		id: "seed-notes",
		name: "homelab-notes.txt",
		type: "source_document",
		mimeType: "text/plain",
		sizeBytes: 7_400,
		ageDays: 5,
		metadata: null,
	},
	{
		id: "seed-tone-history",
		name: "handover.docx",
		type: "source_document",
		mimeType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		sizeBytes: 812_000,
		ageDays: 9,
		metadata: {
			documentFamilyId: "family-handover",
			documentFamilyStatus: "historical",
			versionNumber: 1,
		},
	},
	{
		id: "seed-sheet",
		name: "energy-costs-2026.xlsx",
		type: "source_document",
		mimeType:
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		sizeBytes: 96_000,
		ageDays: 12,
		metadata: {
			documentFamilyId: "family-costs",
			documentFamilyStatus: "active",
			versionNumber: 4,
		},
	},
	{
		id: "seed-atlas-08",
		name: "atlas-battery-rules-2026-08.pdf",
		type: "generated_output",
		mimeType: "application/pdf",
		sizeBytes: 1_200_000,
		ageDays: 28,
		metadata: {
			documentFamilyId: "family-atlas-aug",
			documentFamilyStatus: "historical",
			versionNumber: 1,
			sourceChatFileId: "chat-file-atlas-aug",
		},
		conversationId: SEED_CONVERSATION_ID,
	},
];

// Twenty-four rows in total: the nine characterful ones above, then filler to
// carry the library past the 20-per-page default so the pager is on screen to
// be photographed at all.
const FILLER_DOCUMENTS: SeedDocument[] = Array.from(
	{ length: 15 },
	(_, index) => ({
		id: `seed-filler-${index}`,
		name: `meeting-notes-2026-0${(index % 9) + 1}-${String(index + 1).padStart(2, "0")}.md`,
		type: "source_document",
		mimeType: "text/markdown",
		sizeBytes: 4_000 + index * 1_300,
		ageDays: 30 + index,
		metadata:
			index % 3 === 0
				? {
						documentFamilyId: `family-filler-${index}`,
						documentFamilyStatus: index % 6 === 0 ? "active" : "historical",
						versionNumber: (index % 4) + 1,
					}
				: null,
	}),
);

function seedDocuments() {
	const databasePath = process.env.DATABASE_PATH;
	if (!databasePath) return false;
	const db = new Database(databasePath);
	try {
		const user = db
			.prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
			.get("admin@local") as { id: string } | undefined;
		if (!user) return false;
		const now = Math.floor(Date.now() / 1000);
		const insertConversation = db.prepare(
			`INSERT OR REPLACE INTO conversations
			 (id, user_id, title, created_at, updated_at)
			 VALUES (@id, @userId, @title, @createdAt, @createdAt)`,
		);
		const insert = db.prepare(
			`INSERT OR REPLACE INTO artifacts
			 (id, user_id, conversation_id, type, retrieval_class, name, mime_type,
			  extension, size_bytes, binary_hash, storage_path, content_text,
			  summary, metadata_json, created_at, updated_at)
			 VALUES (@id, @userId, @conversationId, @type, 'durable', @name,
			         @mimeType, @extension, @sizeBytes, NULL, NULL, @contentText,
			         NULL, @metadataJson, @createdAt, @createdAt)`,
		);
		db.transaction(() => {
			insertConversation.run({
				id: SEED_CONVERSATION_ID,
				userId: user.id,
				title: "Atlas report on EU battery rules",
				createdAt: now - 86_400,
			});
			for (const seed of [...SEED_DOCUMENTS, ...FILLER_DOCUMENTS]) {
				insert.run({
					id: seed.id,
					userId: user.id,
					conversationId: seed.conversationId ?? null,
					type: seed.type,
					name: seed.name,
					mimeType: seed.mimeType,
					extension: seed.name.split(".").pop() ?? null,
					sizeBytes: seed.sizeBytes,
					contentText: `Seeded content for ${seed.name}.`,
					metadataJson: seed.metadata ? JSON.stringify(seed.metadata) : null,
					createdAt: now - seed.ageDays * 86_400,
				});
			}
		})();
		return true;
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------------------
async function json(route: import("@playwright/test").Route, body: unknown) {
	await route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}

async function stubMemory(page: Page) {
	await page.route("**/api/knowledge/memory/summary*", (route) =>
		json(route, MEMORY_SUMMARY),
	);
	await page.route("**/api/knowledge/memory/timeline*", (route) =>
		json(route, MEMORY_TIMELINE),
	);
	await page.route("**/api/knowledge/memory/overview*", (route) =>
		json(route, MEMORY_OVERVIEW),
	);
	await page.route("**/api/knowledge/memory", (route) =>
		json(route, MEMORY_PROFILE),
	);
}

async function setTheme(page: Page, theme: "light" | "dark") {
	await page.evaluate((next) => {
		localStorage.setItem("theme", next);
		document.documentElement.classList.toggle("dark", next === "dark");
	}, theme);
	await page.waitForTimeout(200);
}

async function reassert(page: Page, theme: "light" | "dark") {
	await page.evaluate((next) => {
		document.documentElement.classList.toggle("dark", next === "dark");
	}, theme);
	await page.waitForTimeout(150);
}

/** Full-page shot. */
async function shoot(page: Page, name: string, theme: "light" | "dark") {
	ensureDir();
	await reassert(page, theme);
	await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
}

/** Element shot — for hover detail, where a full page makes it unreadable. */
async function shootEl(
	page: Page,
	locator: import("@playwright/test").Locator,
	name: string,
	theme: "light" | "dark",
	pad = 14,
) {
	ensureDir();
	await reassert(page, theme);
	await locator.scrollIntoViewIfNeeded().catch(() => {});
	const box = await locator.boundingBox();
	if (!box) return;
	// boundingBox() is in viewport coordinates, so a clip that runs past the
	// viewport edge is rejected outright ("clipped area is empty"). Clamp.
	const viewport = page.viewportSize();
	const maxWidth = viewport?.width ?? box.x + box.width + pad;
	const maxHeight = viewport?.height ?? box.y + box.height + pad;
	const x = Math.max(0, box.x - pad);
	const y = Math.max(0, box.y - pad);
	const width = Math.min(box.width + pad * 2, maxWidth - x);
	const height = Math.min(box.height + pad * 2, maxHeight - y);
	if (width <= 1 || height <= 1) return;
	await page.screenshot({
		path: `${DIR}/${name}.png`,
		clip: { x, y, width, height },
	});
}

const WIDTHS: Array<[string, number, number]> = [
	["1440", 1440, 1000],
	["1024", 1024, 900],
	["390", 390, 844],
];

test.describe("knowledge polish captures", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	for (const theme of ["light", "dark"] as const) {
		// -------------------------------------------------------------- memory
		test(`memory states (${theme})`, async ({ page }) => {
			await stubMemory(page);

			for (const [label, width, height] of WIDTHS) {
				await page.setViewportSize({ width, height });
				await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
				await waitForHydration(page);
				await setTheme(page, theme);
				await page.waitForTimeout(600);

				await shoot(page, `mem-rest-${label}-${theme}`, theme);

				// Category expanded.
				await page.getByTestId("memory-category-disclosure").first().click();
				await page.waitForTimeout(600);
				await shoot(page, `mem-expanded-${label}-${theme}`, theme);
				await page.getByTestId("memory-category-disclosure").first().click();
				await page.waitForTimeout(500);

				// Filter active.
				const filterBox = page.getByRole("searchbox", {
					name: "Filter memories",
				});
				await filterBox.fill("nextcloud");
				await page.waitForTimeout(400);
				await shoot(page, `mem-filtered-${label}-${theme}`, theme);
				await page.getByRole("button", { name: "Clear filter" }).click();
				await page.waitForTimeout(400);
			}

			// Hover detail at 1440 only — the states are a few pixels each.
			await page.setViewportSize({ width: 1440, height: 1000 });
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await setTheme(page, theme);
			await page.waitForTimeout(600);

			const section = page.locator(".memory-section").first();

			// Row hovered — shoot three rows so the hover fill can be compared
			// against its neighbours.
			const rows = page.getByTestId("memory-row");
			await rows.nth(1).hover();
			await page.waitForTimeout(350);
			await shootEl(page, section, `mem-row-hover-${theme}`, theme, 6);

			// Edit hovered.
			await rows
				.nth(1)
				.getByRole("button", { name: /Edit memory|View memory/ })
				.first()
				.hover();
			await page.waitForTimeout(350);
			await shootEl(page, section, `mem-edit-hover-${theme}`, theme, 6);

			// Remove hovered.
			await rows
				.nth(1)
				.getByRole("button", { name: /Remove/ })
				.first()
				.hover();
			await page.waitForTimeout(350);
			await shootEl(page, section, `mem-remove-hover-${theme}`, theme, 6);

			// Chip hovered.
			const chip = page
				.getByTestId("memory-filter-chip")
				.filter({ hasText: "Preferences" });
			await chip.hover();
			await page.waitForTimeout(350);
			await shootEl(
				page,
				page.locator(".memory-filter-bar"),
				`mem-chip-hover-${theme}`,
				theme,
				8,
			);

			// Disclosure hovered (foot row alignment against the rows above it).
			await page.getByTestId("memory-category-disclosure").first().hover();
			await page.waitForTimeout(350);
			await shootEl(page, section, `mem-disclosure-hover-${theme}`, theme, 6);

			// Needs review card hovered.
			const reviewCard = page.locator(".memory-review-card").first();
			await reviewCard.hover();
			await page.waitForTimeout(350);
			await shootEl(
				page,
				page.locator(".memory-review-section"),
				`mem-review-hover-${theme}`,
				theme,
				8,
			);

			// Rail cards, resting — paddings and radii side by side.
			await page.mouse.move(5, 5);
			await page.waitForTimeout(250);
			await shootEl(
				page,
				page.locator(".memory-profile-rail"),
				`mem-rail-${theme}`,
				theme,
				10,
			);
		});

		// ----------------------------------------------------------- documents
		test(`documents states (${theme})`, async ({ page }) => {
			seedDocuments();
			await stubMemory(page);

			for (const [label, width, height] of WIDTHS) {
				await page.setViewportSize({ width, height });
				await page.goto("/knowledge?tab=documents", {
					waitUntil: "domcontentloaded",
				});
				await waitForHydration(page);
				await setTheme(page, theme);
				await page.waitForTimeout(700);
				await shoot(page, `doc-rest-${label}-${theme}`, theme);
			}

			await page.setViewportSize({ width: 1440, height: 1000 });
			await page.goto("/knowledge?tab=documents", {
				waitUntil: "domcontentloaded",
			});
			await waitForHydration(page);
			await setTheme(page, theme);
			await page.waitForTimeout(700);

			const table = page.locator(".table-container");
			const controls = page.locator(".filter-controls");

			// Row hovered.
			await page.locator(".document-row").nth(2).hover();
			await page.waitForTimeout(350);
			await shootEl(page, table, `doc-row-hover-${theme}`, theme, 6);

			// Action button hovered.
			await page
				.locator(".document-row")
				.nth(2)
				.locator(".action-btn")
				.nth(1)
				.hover();
			await page.waitForTimeout(350);
			await shootEl(page, table, `doc-action-hover-${theme}`, theme, 6);

			// Sort header hovered + active.
			await page.locator("th.col-name .sort-button").hover();
			await page.waitForTimeout(300);
			await shootEl(page, table, `doc-sortheader-hover-${theme}`, theme, 6);
			await page.locator("th.col-name .sort-button").click();
			await page.waitForTimeout(400);
			await page.mouse.move(5, 5);
			await page.waitForTimeout(250);
			await shootEl(page, table, `doc-sortheader-active-${theme}`, theme, 6);

			// Sort control + upload button, resting and hovered.
			await shootEl(page, controls, `doc-controls-${theme}`, theme, 8);
			await page
				.getByRole("button", { name: /Upload/ })
				.first()
				.hover();
			await page.waitForTimeout(350);
			await shootEl(page, controls, `doc-upload-hover-${theme}`, theme, 8);
			await page.locator(".sort-select").focus();
			await page.waitForTimeout(300);
			await shootEl(page, controls, `doc-sort-focus-${theme}`, theme, 8);

			// Bulk bar with two selected.
			await page.mouse.move(5, 5);
			await page
				.locator(".document-row")
				.nth(0)
				.locator(".custom-checkbox")
				.check();
			await page
				.locator(".document-row")
				.nth(2)
				.locator(".custom-checkbox")
				.check();
			await page.waitForTimeout(400);
			await shoot(page, `doc-bulk-${theme}`, theme);
			await shootEl(
				page,
				page.locator(".bulk-action-bar"),
				`doc-bulk-bar-${theme}`,
				theme,
				10,
			);
			await page.locator(".bulk-action-bar .bulk-btn-danger").hover();
			await page.waitForTimeout(350);
			await shootEl(
				page,
				page.locator(".bulk-action-bar"),
				`doc-bulk-danger-hover-${theme}`,
				theme,
				10,
			);
			await page
				.locator(".bulk-action-bar .bulk-actions .bulk-btn-secondary")
				.hover();
			await page.waitForTimeout(350);
			await shootEl(
				page,
				page.locator(".bulk-action-bar"),
				`doc-bulk-clear-hover-${theme}`,
				theme,
				10,
			);
			await page
				.locator(".bulk-action-bar .bulk-btn-secondary")
				.first()
				.click();
			await page.waitForTimeout(300);

			// Pager — the seed carries 24 rows past the 20-per-page default, so
			// it is on screen without touching the page-size control.
			const pager = page.locator(".pagination");
			if (await pager.count()) {
				await page.mouse.move(5, 5);
				await page.waitForTimeout(200);
				await shootEl(page, pager, `doc-pager-${theme}`, theme, 10);
				await page.locator(".pagination-btn").last().hover();
				await page.waitForTimeout(350);
				await shootEl(page, pager, `doc-pager-hover-${theme}`, theme, 10);
			}

			// The drop hint that sits under the pager, and the table foot with
			// it — the resting shot is cut off by the viewport up top.
			const dropHint = page.getByTestId("drop-hint");
			if (await dropHint.count()) {
				await page.mouse.move(5, 5);
				await page.waitForTimeout(200);
				await shootEl(page, dropHint, `doc-drophint-${theme}`, theme, 10);
			}

			// Drop zone.
			await page.evaluate(() => {
				const wrapper = document.querySelector(".documents-list-wrapper");
				if (!wrapper) return;
				const dt = new DataTransfer();
				dt.items.add(new File(["x"], "x.pdf", { type: "application/pdf" }));
				wrapper.dispatchEvent(
					new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }),
				);
			});
			await page.waitForTimeout(450);
			await shoot(page, `doc-dropzone-${theme}`, theme);
		});
	}
});
