// Screenshot capture for the chat CHIPS redesign (composer pills + the
// pills that show inside the message stream). It asserts nothing CI needs —
// it drives the real app so every chip state can be photographed in both
// themes at two widths, and writes PNGs to a scratch directory that only
// exists on the machine that made them.
//
// So it SKIPS unless CHIPS_CAPTURE=1, exactly like zz-capture-composer.spec.ts.
//
//   CHIPS_CAPTURE=1 E2E_PORT=5214 npx playwright test tests/e2e/zz-capture-chips.spec.ts
import { expect, type Page, test } from "@playwright/test";
import { login } from "./helpers";

test.skip(
	process.env.CHIPS_CAPTURE !== "1",
	"screenshot capture helper — set CHIPS_CAPTURE=1 to run it",
);

const OUT =
	process.env.CHIPS_CAPTURE_OUT ||
	"/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/dc2da4d4-d513-4098-9b2b-8b6c426191eb/scratchpad/chips-redesign/current";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// A 1x1 transparent PNG — enough for the image-attachment chip, which today
// renders a generic file-type glyph and never looks at the bytes.
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

async function setAdminConfig(page: Page, values: Record<string, string>) {
	const response = await page.evaluate(async (payload) => {
		const result = await fetch("/api/admin/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		return { ok: result.ok, status: result.status };
	}, values);
	expect(response.ok, `admin config PUT -> ${response.status}`).toBe(true);
}

async function setTheme(page: Page, theme: "light" | "dark") {
	const status = await page.evaluate(async (next) => {
		const r = await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ theme: next }),
		});
		return r.status;
	}, theme);
	expect(status, `theme PATCH -> ${status}`).toBeLessThan(400);
}

async function settle(page: Page) {
	await page.waitForTimeout(500);
}

// Crop to the composer plus a little air above it, so the PNG is about the
// chips rather than the whole app chrome.
async function shotComposer(page: Page, name: string, above = 200) {
	const composer = page.locator(".message-composer").first();
	await composer.waitFor({ state: "visible", timeout: 15000 });
	// Svelte re-creates the composer subtree when chips come and go, so a
	// bounding box read straight after an interaction can land on a detached
	// node. Retry until one measurement survives.
	let box: { x: number; y: number; width: number; height: number } | null = null;
	for (let attempt = 0; attempt < 8 && !box; attempt += 1) {
		try {
			await composer.scrollIntoViewIfNeeded({ timeout: 5000 });
			box = await composer.boundingBox();
		} catch {
			await page.waitForTimeout(250);
		}
	}
	if (!box) throw new Error(`composer not measurable for ${name}`);
	const viewport = page.viewportSize();
	if (!viewport) throw new Error(`no viewport for ${name}`);
	const y = Math.max(0, box.y - above);
	await page.screenshot({
		path: `${OUT}/${name}.png`,
		clip: {
			x: Math.max(0, box.x - 24),
			y,
			width: Math.min(viewport.width - Math.max(0, box.x - 24), box.width + 48),
			height: Math.min(viewport.height - y, box.height + (box.y - y) + 40),
		},
	});
}

type UploadArtifact = {
	id: string;
	name: string;
	mimeType: string;
	sizeBytes: number;
	tokenEstimate?: number;
	pageCount?: number;
	outline?: { level: number; title: string; offset: number; preview: string }[];
};

const PDF_ARTIFACT: UploadArtifact = {
	id: "artifact-lease",
	name: "Lease agreement 2026.pdf",
	mimeType: "application/pdf",
	sizeBytes: 482_112,
	tokenEstimate: 18_400,
	pageCount: 24,
	outline: [
		{
			level: 1,
			title: "1. Parties and premises",
			offset: 0,
			preview: "This agreement is made between Hartland Holdings Kft.",
		},
		{
			level: 2,
			title: "2.3 Break clause",
			offset: 120,
			preview: "Either party may terminate on six months' written notice",
		},
		{
			level: 2,
			title: "4.1 Service charge",
			offset: 240,
			preview: "The service charge is recalculated each January",
		},
	],
};

const IMAGE_ARTIFACT: UploadArtifact = {
	id: "artifact-floorplan",
	name: "floor-plan-level-2.png",
	mimeType: "image/png",
	sizeBytes: 1_204_889,
};

// One route for /api/knowledge/upload that answers with whatever artifact is
// next in the queue, so the same helper can stage a PDF and then an image.
async function mockChipRoutes(page: Page) {
	const uploadQueue: UploadArtifact[] = [];

	await page.route("**/api/skills/discovery**", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				skills: [
					{
						id: "skill-invoice-reply",
						ownership: "user",
						displayName: "Invoice reply",
						description: "Draft a reply to an overdue invoice.",
						activationExamples: ["reply to this invoice"],
						enabled: true,
						durationPolicy: "session",
						questionPolicy: "ask_when_needed",
						notesPolicy: "none",
						sourceScope: "selected_sources_only",
						creationSource: "user_created",
						version: 1,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}),
		});
	});

	await page.route("**/api/knowledge", async (route) => {
		if (route.request().method() !== "GET") {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documents: [
					{
						id: "display-handbook",
						displayArtifactId: "display-handbook",
						promptArtifactId: "prompt-handbook",
						familyArtifactIds: ["display-handbook", "prompt-handbook"],
						name: "Employee handbook.docx",
						mimeType:
							"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
						sizeBytes: 220_000,
						conversationId: null,
						summary: "Employee handbook",
						normalizedAvailable: true,
						documentOrigin: "uploaded",
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: "display-q3",
						displayArtifactId: "display-q3",
						promptArtifactId: "prompt-q3",
						familyArtifactIds: ["display-q3", "prompt-q3"],
						name: "Q3 board pack.pdf",
						mimeType: "application/pdf",
						sizeBytes: 980_000,
						conversationId: null,
						summary: "Q3 board pack",
						normalizedAvailable: true,
						documentOrigin: "generated",
						createdAt: 2,
						updatedAt: 2,
					},
				],
				results: [],
				workflows: [],
			}),
		});
	});

	// The client uploads in two hops: an intent call, then the raw body.
	await page.route("**/api/knowledge/upload/intent", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				traceId: `trace-${Date.now()}`,
				rawUploadLimit: 50_000_000,
				requestBodyLimit: 50_000_000,
				chunkBodyLimit: 4_000_000,
			}),
		});
	});

	await page.route("**/api/knowledge/upload/raw", async (route) => {
		const artifact = uploadQueue.shift() ?? IMAGE_ARTIFACT;
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				artifact: {
					id: artifact.id,
					type: "source_document",
					retrievalClass: "durable",
					name: artifact.name,
					mimeType: artifact.mimeType,
					sizeBytes: artifact.sizeBytes,
					conversationId: null,
					summary: artifact.name,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					...(artifact.tokenEstimate
						? { tokenEstimate: artifact.tokenEstimate }
						: {}),
					...(artifact.pageCount ? { pageCount: artifact.pageCount } : {}),
					...(artifact.outline ? { outline: artifact.outline } : {}),
				},
				promptReady: true,
				promptArtifactId: `prompt-${artifact.id}`,
				readinessError: null,
			}),
		});
	});

	return {
		queueUpload(artifact: UploadArtifact) {
			uploadQueue.push(artifact);
		},
	};
}

async function createConversation(page: Page): Promise<string> {
	const conversation = await page.evaluate(async () => {
		const result = await fetch("/api/conversations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Chips capture" }),
		});
		if (!result.ok) throw new Error(`create conversation ${result.status}`);
		return (await result.json()) as { id: string };
	});
	return conversation.id;
}

async function typeCommand(page: Page, command: string) {
	const input = page.getByTestId("message-input");
	await input.fill("");
	await input.click();
	await input.pressSequentially(command);
}

async function addSkillChip(page: Page) {
	await typeCommand(page, "$invoice");
	await page.getByRole("option", { name: /Invoice reply/i }).click();
	await expect(page.locator(".pending-skill-chip").first()).toBeVisible();
	await page.getByTestId("message-input").fill("");
}

async function toggleWebChip(page: Page) {
	await page.getByTestId("composer-tools-trigger").click();
	await expect(page.getByTestId("composer-tools-menu")).toBeVisible();
	await page.getByTestId("composer-menu-web-search").click();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("composer-tools-menu")).toBeHidden();
}

async function pickAtlasProfile(page: Page, label: RegExp) {
	await page.getByTestId("composer-tools-trigger").click();
	await expect(page.getByTestId("composer-tools-menu")).toBeVisible();
	await page.getByTestId("composer-menu-atlas").click();
	await page
		.getByRole("option", { name: label })
		.first()
		.click({ force: true });
	await page.keyboard.press("Escape");
}

async function attach(
	page: Page,
	queue: (artifact: UploadArtifact) => void,
	artifact: UploadArtifact,
	bytes: Buffer,
) {
	queue(artifact);
	await page.locator('input[type="file"]').setInputFiles({
		name: artifact.name,
		mimeType: artifact.mimeType,
		buffer: bytes,
	});
	await expect(page.getByText(artifact.name, { exact: true }).first()).toBeVisible(
		{ timeout: 20000 },
	);
}

async function linkDocuments(page: Page) {
	await typeCommand(page, "/document");
	// Keyboard, not a click: at 390px the tray sits under the textarea, which
	// swallows the pointer. The tray already marks the row as its active
	// descendant, so Enter picks exactly the row a click would have hit.
	await expect(
		page.getByRole("listbox", { name: "Composer commands" }),
	).toBeVisible();
	await page.keyboard.press("Enter");
	const picker = page.getByRole("dialog", { name: "Link Library documents" });
	await expect(picker).toBeVisible();
	await picker.getByRole("checkbox", { name: "Employee handbook.docx" }).check();
	await page.getByRole("button", { name: "Link selected documents" }).click();
	await expect(page.getByText("Employee handbook.docx").first()).toBeVisible();
	await page.getByTestId("message-input").fill("");
}

// The real cap is a megabyte, which no capture can type into. Specs that want
// to photograph the over-length counter shrink it for the page load and put it
// back afterwards (restoreMessageLength below).
const SHORT_MAX_MESSAGE_LENGTH = "400";
const DEFAULT_MAX_MESSAGE_LENGTH = "1048576";

async function bootstrap(
	page: Page,
	theme: "light" | "dark",
	options: { shortMessageCap?: boolean } = {},
) {
	await login(page);
	await setTheme(page, theme);
	await setAdminConfig(page, {
		COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
		ATLAS_WORKER_ENABLED: "true",
		PARALLEL_API_KEY: "fake-chips-capture-key",
		MAX_MESSAGE_LENGTH: options.shortMessageCap
			? SHORT_MAX_MESSAGE_LENGTH
			: DEFAULT_MAX_MESSAGE_LENGTH,
	});
	const routes = await mockChipRoutes(page);
	const conversationId = await createConversation(page);
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 20000,
	});
	await expect
		.poll(async () =>
			page.evaluate(() => document.documentElement.classList.contains("dark")),
		)
		.toBe(theme === "dark");
	await settle(page);
	return routes;
}

for (const theme of ["light", "dark"] as const) {
	test(`desktop ${theme} composer chips`, async ({ page }) => {
		test.setTimeout(180_000);
		await page.setViewportSize(DESKTOP);
		const routes = await bootstrap(page, theme, { shortMessageCap: true });
		const w = `1440-${theme}`;

		await shotComposer(page, `${w}-01-rest`, 80);

		await addSkillChip(page);
		await settle(page);
		await shotComposer(page, `${w}-02-skill-chip`, 80);

		await toggleWebChip(page);
		await settle(page);
		await shotComposer(page, `${w}-03-skill-plus-web`, 120);

		for (const [slug, label] of [
			["overview", /Overview/i],
			["in-depth", /In-Depth/i],
			["exhaustive", /Exhaustive/i],
		] as const) {
			await pickAtlasProfile(page, label);
			await settle(page);
			await shotComposer(page, `${w}-04-atlas-${slug}`, 160);
		}

		await attach(page, routes.queueUpload, PDF_ARTIFACT, Buffer.from("%PDF-1.4"));
		await settle(page);
		await shotComposer(page, `${w}-05-pdf-attached`, 200);

		await attach(page, routes.queueUpload, IMAGE_ARTIFACT, PNG_1X1);
		await settle(page);
		await shotComposer(page, `${w}-06-pdf-plus-image`, 260);

		// The outline panel under the PDF chip — the surface the "quoted text"
		// chip is produced from.
		const outlineHeader = page
			.locator(".attachment-outline-header")
			.first();
		if (await outlineHeader.isVisible().catch(() => false)) {
			await settle(page);
			await shotComposer(page, `${w}-07-attachment-outline`, 300);
			await outlineHeader.hover();
			await page.locator(".attachment-outline-row").first().hover();
			await settle(page);
			await shotComposer(page, `${w}-08-outline-quote-hover`, 300);
			await page.locator(".attachment-outline-row").nth(1).click();
			await settle(page);
			await shotComposer(page, `${w}-09-quote-inserted`, 300);
		}

		await page.getByTestId("message-input").fill("");
		await linkDocuments(page);
		await settle(page);
		await shotComposer(page, `${w}-10-everything-on`, 340);

		// The over-length counter beside the chips.
		await page
			.getByTestId("message-input")
			.fill("Please review the break clause before Friday. ".repeat(12));
		await expect(page.getByTestId("over-length-counter")).toBeVisible();
		await settle(page);
		await shotComposer(page, `${w}-11-over-length-with-chips`, 340);

		// Hover and focus on a remove button — the states the redesign has to
		// improve on.
		await page.getByTestId("message-input").fill("");
		const removeButton = page.locator(".pending-skill-chip__remove").first();
		if (await removeButton.isVisible().catch(() => false)) {
			await removeButton.hover();
			await settle(page);
			await shotComposer(page, `${w}-12-remove-hover`, 340);
			await removeButton.focus();
			await settle(page);
			await shotComposer(page, `${w}-13-remove-focus`, 340);
		}

		await setAdminConfig(page, {
			MAX_MESSAGE_LENGTH: DEFAULT_MAX_MESSAGE_LENGTH,
		});
	});

	test(`phone ${theme} composer chips`, async ({ page }) => {
		test.setTimeout(180_000);
		await page.setViewportSize(PHONE);
		const routes = await bootstrap(page, theme);
		const w = `390-${theme}`;

		await page.screenshot({ path: `${OUT}/${w}-01-rest.png` });

		await addSkillChip(page);
		await toggleWebChip(page);
		await settle(page);
		await page.screenshot({ path: `${OUT}/${w}-02-skill-plus-web.png` });

		// Linked documents first: once the PDF's outline panel is open it
		// covers the command tray at this width, which is itself worth a note.
		await linkDocuments(page);
		await settle(page);
		await page.screenshot({ path: `${OUT}/${w}-03-linked-document.png` });

		await attach(page, routes.queueUpload, PDF_ARTIFACT, Buffer.from("%PDF-1.4"));
		await attach(page, routes.queueUpload, IMAGE_ARTIFACT, PNG_1X1);
		await settle(page);
		await page.screenshot({ path: `${OUT}/${w}-04-everything-on.png` });
	});

	test(`desktop ${theme} queued banner and in-stream chips`, async ({ page }) => {
		test.setTimeout(180_000);
		await page.setViewportSize(DESKTOP);
		const routes = await bootstrap(page, theme);
		const w = `1440-${theme}`;

		// A stream that never finishes: the composer stays in its generating
		// state, which is the only way the queue button (and then the queued
		// banner) appears.
		let releaseStream: (() => void) | null = null;
		const held = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});
		await page.route("**/api/chat/stream", async (route) => {
			await held;
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: [
					'data: {"type":"text-start","id":"a"}\n\n',
					'data: {"type":"text-delta","id":"a","delta":"Here is the reply draft."}\n\n',
					'data: {"type":"text-end","id":"a"}\n\n',
					'data: {"type":"finish"}\n\n',
					"data: [DONE]\n\n",
				].join(""),
			});
		});

		await attach(page, routes.queueUpload, PDF_ARTIFACT, Buffer.from("%PDF-1.4"));
		await page
			.getByTestId("message-input")
			.fill("Draft a reply to the landlord about the break clause.");
		await page.getByTestId("send-button").click();

		await page
			.getByTestId("message-input")
			.fill("Also check the service charge recalculation date.");
		const queueButton = page.getByTestId("queue-button");
		await expect(queueButton).toBeVisible({ timeout: 20000 });
		await settle(page);
		await shotComposer(page, `${w}-20-queue-button`, 200);
		await queueButton.click();
		await expect(page.getByTestId("queued-message-banner")).toBeVisible();
		await settle(page);
		await shotComposer(page, `${w}-21-queued-banner`, 200);

		releaseStream?.();
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Here is the reply draft",
			{ timeout: 30000 },
		);
		await settle(page);
		await page.screenshot({
			path: `${OUT}/${w}-22-stream-after-send.png`,
			fullPage: false,
		});

		// The user bubble carries the attachment chip; the assistant turn's
		// action row carries the follow-up chips. Both live in the stream.
		const userBubble = page.getByTestId("user-message").first();
		if (await userBubble.isVisible().catch(() => false)) {
			await userBubble.scrollIntoViewIfNeeded();
			await userBubble.hover();
			await settle(page);
			await page.screenshot({ path: `${OUT}/${w}-23-user-bubble-chips.png` });
		}
		const assistant = page.getByTestId("assistant-message").first();
		if (await assistant.isVisible().catch(() => false)) {
			await assistant.hover();
			await settle(page);
			await page.screenshot({
				path: `${OUT}/${w}-24-assistant-action-row.png`,
			});
		}
	});
}
