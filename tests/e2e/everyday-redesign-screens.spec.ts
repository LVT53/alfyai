// Smoke + capture spec for the everyday-screens redesign (Knowledge, Search,
// Analytics). The surfaces are driven by API fixtures rather than seeded rows
// so the captures are deterministic and do not depend on a model being
// configured: the components under test are the real ones, and what is faked
// is only the read model the server would have returned.
import { existsSync, mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { login } from "./helpers";

const CAPTURE_DIR =
	process.env.REDESIGN_CAPTURE_DIR ??
	"/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/dc2da4d4-d513-4098-9b2b-8b6c426191eb/scratchpad/everyday-redesign/impl-knowledge";

function ensureCaptureDir() {
	if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// memory profile: 52 memories, the size the board is drawn at
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

// Held totals per category, matching the board: 23 / 14 / 9 / 6 = 52.
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
// workspace search
// ---------------------------------------------------------------------------
function conversation(
	id: string,
	title: string,
	snippet: string | null,
	projectName: string | null = null,
) {
	return {
		id,
		title,
		projectId: projectName ? "project-1" : null,
		projectName,
		status: "active",
		sealedAt: null,
		updatedAt: Date.now(),
		href: `/chat/${id}`,
		match: {
			type: snippet ? "body" : "title",
			snippet,
			messageId: snippet ? `${id}-message` : null,
			messageRole: snippet ? "user" : null,
		},
	};
}

function document(
	id: string,
	name: string,
	origin: "uploaded" | "generated" | "skill_note",
	snippet: string | null,
	familyStatus: "active" | "historical" | null = null,
) {
	return {
		id,
		displayArtifactId: id,
		promptArtifactId: null,
		familyArtifactIds: [id],
		name,
		mimeType: "application/pdf",
		sizeBytes: 1_400_000,
		conversationId: null,
		summary: null,
		documentOrigin: origin,
		documentFamilyStatus: familyStatus,
		documentLabel: null,
		updatedAt: Date.now(),
		href: `/knowledge?open_artifact=${id}`,
		sourceHref: null,
		match: { type: snippet ? "content" : "recent", snippet },
	};
}

const SEARCH_RECENTS = {
	mode: "default",
	query: "",
	conversations: [
		conversation(
			"conv-1",
			"Reply to Kata about the September invoice",
			null,
			"Admin",
		),
		conversation("conv-2", "Nextcloud folder clean-up plan", null, "Homelab"),
		conversation("conv-3", "Flash-Next serving config on alfyroot", null),
		conversation("conv-4", "Balaton trip photo sort", null),
	],
	documents: [
		document(
			"artifact-1",
			"atlas-battery-rules-2026-09.pdf",
			"generated",
			null,
		),
		document("artifact-2", "invoice-2026-09.pdf", "uploaded", null),
	],
	documentOverflow: true,
	knowledgeHref: "/knowledge",
};

const SEARCH_RESULTS = {
	mode: "query",
	query: "battery",
	conversations: [
		conversation(
			"conv-5",
			"Atlas report on EU battery rules",
			"…compare the two battery-rule drafts and say what changed…",
		),
		conversation(
			"conv-3",
			"Flash-Next serving config on alfyroot",
			"…the battery-backed cache on GPU0…",
		),
	],
	documents: [
		document(
			"artifact-1",
			"atlas-battery-rules-2026-09.pdf",
			"generated",
			"…Annex II of the battery regulation now covers…",
		),
		document(
			"artifact-3",
			"atlas-battery-rules-2026-08.pdf",
			"generated",
			"Superseded by v3",
			"historical",
		),
		document(
			"artifact-4",
			"battery-notes.md",
			"skill_note",
			"…battery chemistry notes…",
		),
	],
	documentOverflow: true,
	knowledgeHref: "/knowledge?q=battery",
};

// ---------------------------------------------------------------------------
// analytics
// ---------------------------------------------------------------------------
function modelRow(
	model: string,
	displayName: string,
	msgCount: number,
	totalTokens: number,
	totalCostUsd: number,
) {
	return { model, displayName, msgCount, totalTokens, totalCostUsd };
}

const ANALYTICS = {
	personal: {
		byModel: [
			modelRow("flash-next", "Flash-Next 8B", 4380, 16_800_000, 1.62),
			modelRow("opus-5", "Claude Opus 5", 301, 1_200_000, 0.71),
			modelRow("gpt-52-mini", "GPT-5.2 mini", 131, 400_000, 0.09),
		],
		byProvider: [
			{
				providerId: "local",
				displayName: "alfyroot",
				totalCostUsd: 1.62,
				totalTokens: 16_800_000,
				msgCount: 4380,
			},
			{
				providerId: "anthropic",
				displayName: "Anthropic",
				totalCostUsd: 0.71,
				totalTokens: 1_200_000,
				msgCount: 301,
			},
			{
				providerId: "openai",
				displayName: "OpenAI",
				totalCostUsd: 0.09,
				totalTokens: 400_000,
				msgCount: 131,
			},
		],
		totalMessages: 4812,
		avgGenerationMs: 820,
		totalTokens: 18_400_000,
		promptTokens: 5_600_000,
		cachedInputTokens: 1_100_000,
		outputTokens: 12_800_000,
		reasoningTokens: 5_600_000,
		totalCostUsd: 2.4231,
		favoriteModel: "flash-next",
		chatCount: 312,
		monthly: [
			{
				month: "2026-09",
				messages: 4812,
				totalTokens: 18_400_000,
				totalCostUsd: 2.4231,
			},
			{
				month: "2026-08",
				messages: 4400,
				totalTokens: 17_000_000,
				totalCostUsd: 2.63,
			},
			{
				month: "2026-07",
				messages: 3900,
				totalTokens: 15_000_000,
				totalCostUsd: 2.2,
			},
		],
	},
	system: {
		totalMessages: 41_208,
		avgGenerationMs: 910,
		totalTokens: 312_000_000,
		promptTokens: 120_000_000,
		cachedInputTokens: 40_000_000,
		outputTokens: 150_000_000,
		reasoningTokens: 42_000_000,
		totalCostUsd: 128.74,
		totalUsers: 9,
		totalConversations: 2714,
		byModel: [
			{
				...modelRow("flash-next", "Flash-Next 8B", 36_140, 261_000_000, 42.18),
				providerDisplayName: "alfyroot",
				availability: "active",
				firstTokenP50Ms: 412,
				firstTokenP90Ms: 1140,
				generationP50Ms: 860,
				avgReasoningTokens: 320,
			},
			{
				...modelRow("opus-5", "Claude Opus 5", 3402, 38_000_000, 38.9),
				providerDisplayName: "Anthropic",
				availability: "active",
				firstTokenP50Ms: 640,
				firstTokenP90Ms: 1720,
				generationP50Ms: 1500,
				avgReasoningTokens: 1200,
			},
			{
				...modelRow("gpt-52", "GPT-5.2", 1666, 13_000_000, 15.23),
				providerDisplayName: "OpenAI",
				availability: "active",
				firstTokenP50Ms: 520,
				firstTokenP90Ms: 1400,
				generationP50Ms: 1100,
				avgReasoningTokens: 700,
			},
		],
		byProvider: [
			{
				providerId: "local",
				displayName: "alfyroot",
				totalCostUsd: 42.18,
				totalTokens: 261_000_000,
				msgCount: 36_140,
			},
			{
				providerId: "anthropic",
				displayName: "Anthropic",
				totalCostUsd: 38.9,
				totalTokens: 38_000_000,
				msgCount: 3402,
			},
		],
		monthly: [
			{
				month: "2026-09",
				messages: 41_208,
				totalTokens: 312_000_000,
				totalCostUsd: 128.74,
			},
			{
				month: "2026-08",
				messages: 38_000,
				totalTokens: 290_000_000,
				totalCostUsd: 112.93,
			},
			{
				month: "2026-07",
				messages: 35_000,
				totalTokens: 260_000_000,
				totalCostUsd: 96.4,
			},
			{
				month: "2026-06",
				messages: 33_000,
				totalTokens: 240_000_000,
				totalCostUsd: 88.1,
			},
		],
		parallel: {
			monthly: [
				{
					month: "2026-09",
					turboCalls: 4118,
					extractCalls: 2302,
					costUsd: 32.43,
				},
				{
					month: "2026-08",
					turboCalls: 3600,
					extractCalls: 2000,
					costUsd: 28.1,
				},
			],
			totalTurboCalls: 4118,
			totalExtractCalls: 2302,
			totalCostUsd: 32.43,
		},
	},
	perUser: [
		{
			userId: "user-1",
			displayName: "Admin User",
			email: "admin@local",
			messageCount: 4812,
			avgGenerationMs: 820,
			totalTokens: 18_400_000,
			promptTokens: 5_600_000,
			outputTokens: 12_800_000,
			reasoningTokens: 5_600_000,
			totalCostUsd: 2.42,
			favoriteModel: "flash-next",
			conversationCount: 312,
		},
	],
	availableMonths: ["2026-07", "2026-08", "2026-09"],
	systemAvailableMonths: ["2026-06", "2026-07", "2026-08", "2026-09"],
	timeline: [
		{ label: "late Jul", tokens: 310_000 },
		{ label: "w2", tokens: 420_000 },
		{ label: "w3", tokens: 388_000 },
		{ label: "Aug", tokens: 512_000 },
		{ label: "w5", tokens: 470_000 },
		{ label: "w6", tokens: 604_000 },
		{ label: "this week", tokens: 690_000 },
	],
	tools: [],
	commandsAndSkills: [],
	latencyByPromptBucket: [],
};

// ---------------------------------------------------------------------------
// documents: real rows, because the Documents tab is server-rendered
// ---------------------------------------------------------------------------
interface SeedDocument {
	id: string;
	name: string;
	type: string;
	mimeType: string;
	sizeBytes: number;
	ageDays: number;
	metadata: Record<string, unknown> | null;
}

// The board's five rows: a current generated report at v3, a versioned skill
// note, an original upload, an unversioned CSV (blank status, greyed eye), and
// the superseded v1 of the report.
const SEED_DOCUMENTS: SeedDocument[] = [
	{
		id: "seed-atlas-09",
		name: "atlas-battery-rules-2026-09.pdf",
		type: "generated_output",
		mimeType: "application/pdf",
		sizeBytes: 1_400_000,
		ageDays: 0,
		metadata: {
			documentFamilyId: "family-atlas",
			documentFamilyStatus: "active",
			versionNumber: 3,
		},
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
		id: "seed-atlas-08",
		name: "atlas-battery-rules-2026-08.pdf",
		type: "generated_output",
		mimeType: "application/pdf",
		sizeBytes: 1_200_000,
		ageDays: 28,
		metadata: {
			documentFamilyId: "family-atlas",
			documentFamilyStatus: "historical",
			versionNumber: 1,
		},
	},
];

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
		const insert = db.prepare(
			`INSERT OR REPLACE INTO artifacts
			 (id, user_id, conversation_id, type, retrieval_class, name, mime_type,
			  extension, size_bytes, binary_hash, storage_path, content_text,
			  summary, metadata_json, created_at, updated_at)
			 VALUES (@id, @userId, NULL, @type, 'durable', @name, @mimeType,
			         @extension, @sizeBytes, NULL, NULL, @contentText, NULL,
			         @metadataJson, @createdAt, @createdAt)`,
		);
		db.transaction(() => {
			for (const seed of SEED_DOCUMENTS) {
				insert.run({
					id: seed.id,
					userId: user.id,
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
	// Must come last: the bare /memory route would otherwise swallow the three
	// more specific paths above.
	await page.route("**/api/knowledge/memory", (route) =>
		json(route, MEMORY_PROFILE),
	);
}

async function stubSearch(page: Page) {
	await page.route("**/api/workspace-search*", (route) => {
		const query = new URL(route.request().url()).searchParams.get("q") ?? "";
		return json(route, query.trim() ? SEARCH_RESULTS : SEARCH_RECENTS);
	});
}

async function stubAnalytics(page: Page) {
	await page.route("**/api/analytics*", (route) => json(route, ANALYTICS));
}

// SvelteKit renders `#svelte-announcer` only once the root component has
// mounted, so its arrival is the framework's own word that the page is
// hydrated. Clicking before that lands on inert server markup: the button is
// visible and Playwright's actionability checks pass, but no handler is
// attached yet and the click is silently swallowed.
async function waitForHydration(page: Page) {
	await page.waitForSelector("#svelte-announcer", {
		state: "attached",
		timeout: 20_000,
	});
}

async function setTheme(page: Page, theme: "light" | "dark") {
	await page.evaluate((next) => {
		localStorage.setItem("theme", next);
		document.documentElement.classList.toggle("dark", next === "dark");
	}, theme);
	await page.waitForTimeout(200);
}

async function capture(page: Page, name: string, theme?: "light" | "dark") {
	ensureCaptureDir();
	if (theme) {
		// The app syncs its own theme class on hydration and after navigation,
		// so re-assert it immediately before the shutter.
		await page.evaluate((next) => {
			document.documentElement.classList.toggle("dark", next === "dark");
		}, theme);
		await page.waitForTimeout(250);
	}
	// Full-page captures still start wherever the test left the scroll, so
	// bring the page back to the top first.
	await page.evaluate(() => {
		window.scrollTo(0, 0);
		for (const node of document.querySelectorAll("*")) {
			if (node.scrollTop > 0) node.scrollTop = 0;
		}
	});
	await page.waitForTimeout(150);
	await page.screenshot({
		path: `${CAPTURE_DIR}/${name}.png`,
		fullPage: true,
	});
}

test.describe("everyday redesign screens", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	for (const theme of ["light", "dark"] as const) {
		test(`knowledge memory profile at full size (${theme})`, async ({
			page,
		}) => {
			await stubMemory(page);
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await setTheme(page, theme);

			await expect(
				page.getByRole("heading", { name: "Knowledge Base" }),
			).toBeVisible();

			// Fifty-two memories, not twelve: About You alone holds 23.
			const aboutCount = page.getByTestId("memory-category-count").first();
			await expect(aboutCount).toHaveText(/23 remembered · showing 5/);
			await expect(
				page.getByTestId("memory-filter-chip").first(),
			).toContainText("52");

			// Open one category in place and confirm the disclosure turns around.
			const disclosure = page.getByTestId("memory-category-disclosure").first();
			await expect(disclosure).toHaveText(/Show all 23/);
			await disclosure.click();
			await expect(
				page.getByTestId("memory-category-disclosure").first(),
			).toHaveText(/Show fewer/);
			await expect(aboutCount).toHaveText(/showing 23/);

			await capture(page, `knowledge-memory-${theme}`, theme);

			// The filter box narrows every category at once, and the chip counts
			// follow it: "52" becomes the number of memories that match.
			const filterBox = page.getByRole("searchbox", {
				name: "Filter memories",
			});
			await filterBox.fill("nextcloud");
			const allChip = page.getByTestId("memory-filter-chip").first();
			await expect(allChip).not.toContainText("52");
			await expect(aboutCount).toHaveText(/of 23 match/);

			// And a chip narrows to one category: only that section survives.
			const preferencesChip = page
				.getByTestId("memory-filter-chip")
				.filter({ hasText: "Preferences" });
			await preferencesChip.click();
			await expect(preferencesChip).toHaveAttribute("aria-pressed", "true");
			await expect(page.locator(".memory-section")).toHaveCount(1);
			await expect(page.locator(".memory-section")).toHaveAttribute(
				"data-category",
				"preferences",
			);

			await capture(page, `knowledge-memory-filtered-${theme}`, theme);

			// Clearing the box puts every category back.
			await page
				.getByRole("button", { name: "Clear filter" })
				.click();
			await page.getByTestId("memory-filter-chip").first().click();
			await expect(page.locator(".memory-section")).toHaveCount(4);
			await expect(allChip).toContainText("52");
		});

		test(`knowledge documents tab (${theme})`, async ({ page }) => {
			const seeded = seedDocuments();
			await stubMemory(page);
			await page.goto("/knowledge?tab=documents", {
				waitUntil: "domcontentloaded",
			});
			await waitForHydration(page);
			await setTheme(page, theme);

			await expect(
				page.getByRole("heading", { name: "Documents" }),
			).toBeVisible();

			if (seeded) {
				const table = page.locator("table.documents-table");
				await expect(table).toBeVisible();

				// Name, Version, Type, Status — four columns in the approved order,
				// with the two blank leading columns for selection and the glyph.
				const headers = await table
					.locator("thead th")
					.evaluateAll((nodes) =>
						nodes.map((node) =>
							(node.textContent ?? "")
								.replace(/[\u2195\u2191\u2193]/g, "")
								.trim(),
						),
					);
				expect(headers.slice(2, 6)).toEqual([
					"Name",
					"Version",
					"Type",
					"Status",
				]);

				// An upload with no version family is neither current nor
				// historical, so its Status cell stays blank.
				const csvRow = table.locator("tbody tr", {
					hasText: "nextcloud-folder-audit.csv",
				});
				await expect(csvRow).toBeVisible();
				await expect(csvRow.locator(".col-status")).toHaveText("\u2014");

				// The eye keeps its slot, greyed, where no normalised version exists.
				await expect(
					page.getByTestId("what-ai-sees-disabled").first(),
				).toBeVisible();
			}

			await capture(page, `knowledge-documents-${theme}`, theme);
		});

		test(`search palette, before and after typing (${theme})`, async ({
			page,
		}) => {
			await stubSearch(page);
			// `login` already lands on "/" — navigating again here aborts the
			// in-flight route modules and the page never finishes hydrating.
			await page.waitForSelector('[data-testid="new-conversation"]', {
				state: "visible",
			});
			await waitForHydration(page);
			await setTheme(page, theme);

			await page
				.getByRole("button", { name: "Search conversations and documents" })
				.click();
			const modal = page.getByRole("dialog", { name: "Search workspace" });
			await modal.waitFor({ state: "visible" });

			// The empty box is already useful: recents under their own headings.
			await expect(modal.getByText("Recent conversations")).toBeVisible();
			await expect(modal.getByTestId("search-result-count")).toHaveCount(0);
			await capture(page, `search-recents-${theme}`, theme);

			await modal.locator('input[type="text"]').fill("battery");
			await expect(modal.getByTestId("search-result-count")).toBeVisible();
			// Four kinds of result, each under its own heading.
			await expect(modal.getByText("Reports")).toHaveCount(2);
			await capture(page, `search-results-${theme}`, theme);
		});

		test(`personal analytics (${theme})`, async ({ page }) => {
			await stubAnalytics(page);
			await page.goto("/settings", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await setTheme(page, theme);

			const hero = page.getByTestId("analytics-hero").first();
			await hero.scrollIntoViewIfNeeded();
			await expect(hero).toContainText("$2.42");
			await expect(page.getByTestId("analytics-split").first()).toBeVisible();
			await expect(
				page.getByTestId("analytics-column-chart").first(),
			).toBeVisible();

			await capture(page, `analytics-personal-${theme}`, theme);
		});

		test(`admin system analytics (${theme})`, async ({ page }) => {
			await stubAnalytics(page);
			await page.goto("/settings", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await setTheme(page, theme);

			const administration = page.getByRole("tab", { name: "Administration" });
			if ((await administration.count()) === 0) {
				test.skip(true, "signed-in user is not an administrator");
				return;
			}
			await administration.click();

			const systemAnalytics = page
				.getByRole("button", { name: /System analytics|Analytics/ })
				.first();
			if (await systemAnalytics.isVisible().catch(() => false)) {
				await systemAnalytics.click();
			}

			// Scoped to the system panel: the personal hero may still be mounted
			// behind the Profile tab, and `.first()` would pick that one.
			const hero = page
				.locator("#system-analytics-overview-panel")
				.getByTestId("analytics-hero");
			await hero.waitFor({ state: "visible", timeout: 15000 });
			await expect(hero).toContainText("$128.74");
			// The split adds up and names both halves with their amounts.
			await expect(hero).toContainText("LLM · $96.31");
			await expect(hero).toContainText("Parallel · $32.43");

			await capture(page, `analytics-admin-${theme}`, theme);
		});
	}
});
