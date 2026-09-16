// Screenshot capture for the chat CHIPS redesign (composer pills + the
// pills that show inside the message stream). It asserts nothing CI needs —
// it drives the real app so every chip state can be photographed in both
// themes at two widths, and writes PNGs to a scratch directory that only
// exists on the machine that made them.
//
// So it SKIPS unless CHIPS_CAPTURE=1, exactly like zz-capture-composer.spec.ts.
//
//   CHIPS_CAPTURE=1 E2E_PORT=5214 npx playwright test tests/e2e/zz-capture-chips.spec.ts
//
// What it photographs, per theme and per width:
//   * the composer with the Atlas chip alone (warning tint, profile meta,
//     bell BESIDE the pill);
//   * the composer with a skill chip, an image chip (thumbnail) and a file
//     chip (cost meta) in the one row;
//   * a sent turn: the user bubble with its attachment and quote chips, and
//     the assistant footer with its derived provenance line (skill + web).
import { deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import { login } from "./helpers";

test.skip(
	process.env.CHIPS_CAPTURE !== "1",
	"screenshot capture helper — set CHIPS_CAPTURE=1 to run it",
);

const OUT =
	process.env.CHIPS_CAPTURE_OUT ||
	"/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/dc2da4d4-d513-4098-9b2b-8b6c426191eb/scratchpad/chips-redesign/impl";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

// A 64x64 PNG with a visible gradient, so the image chip's thumbnail is
// recognisably a picture rather than a transparent square.
function gradientPng(): Buffer {
	const size = 64;
	const raw: number[] = [];
	for (let y = 0; y < size; y += 1) {
		raw.push(0);
		for (let x = 0; x < size; x += 1) {
			raw.push(
				40 + Math.round((x / size) * 180),
				90 + Math.round((y / size) * 120),
				200 - Math.round((x / size) * 120),
				255,
			);
		}
	}
	const idat = deflateSync(Buffer.from(raw));
	function chunk(type: string, data: Buffer) {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([len, body, crc]);
	}
	function crc32(buffer: Buffer) {
		let c = -1;
		for (const byte of buffer) {
			c ^= byte;
			for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
		}
		return ~c;
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const THUMB_PNG = gradientPng();

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
	let box: { x: number; y: number; width: number; height: number } | null =
		null;
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

	// The image chip's crop comes from the authenticated preview endpoint.
	await page.route("**/api/knowledge/*/preview", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "image/png" },
			body: THUMB_PNG,
		});
	});

	return {
		queueUpload(artifact: UploadArtifact) {
			uploadQueue.push(artifact);
		},
	};
}

async function createConversation(page: Page, title: string): Promise<string> {
	const conversation = await page.evaluate(async (nextTitle) => {
		const result = await fetch("/api/conversations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: nextTitle }),
		});
		if (!result.ok) throw new Error(`create conversation ${result.status}`);
		return (await result.json()) as { id: string };
	}, title);
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
	await expect(page.getByTestId("composer-chip-skill")).toBeVisible();
	await page.getByTestId("message-input").fill("");
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
	await expect(page.getByTestId("composer-chip-atlas")).toBeVisible();
}

async function attach(
	page: Page,
	queue: (artifact: UploadArtifact) => void,
	artifact: UploadArtifact,
	bytes: Buffer,
) {
	queue(artifact);
	const fileInput = page.locator('input[type="file"]');
	await expect(fileInput).toBeEnabled({ timeout: 20000 });
	await fileInput.setInputFiles({
		name: artifact.name,
		mimeType: artifact.mimeType,
		buffer: bytes,
	});
	await expect(
		page
			.getByTestId("composer-chip-attachment")
			.filter({ hasText: artifact.name }),
	).toBeVisible({ timeout: 20000 });
}

// The stream fixture. A universal load on a direct page.goto runs on the
// server, out of reach of page.route, so the in-stream capture navigates
// CLIENT-SIDE to this conversation and patches the real detail response on
// the way through: the same conversation, the same shape, with two turns
// dropped in. thinkingSegments is what the live stream leaves on a message;
// responseActivity is what a reload projects — both are set so the
// provenance line is derived the same way either path would derive it.
function streamFixtureMessages(conversationId: string) {
	const sentAt = Date.now() - 90_000;
	return [
		{
			id: "capture-user-1",
			role: "user",
			content:
				"2.3 Break clause: Either party may terminate on six months' written notice…\n\nCan we get out of this early, and what would it cost us?",
			timestamp: sentAt,
			attachments: [
				{
					id: "link-lease",
					artifactId: PDF_ARTIFACT.id,
					name: PDF_ARTIFACT.name,
					type: "source_document",
					mimeType: PDF_ARTIFACT.mimeType,
					sizeBytes: PDF_ARTIFACT.sizeBytes,
					conversationId,
					messageId: "capture-user-1",
					createdAt: sentAt,
					tokenEstimate: PDF_ARTIFACT.tokenEstimate,
					pageCount: PDF_ARTIFACT.pageCount,
					outline: PDF_ARTIFACT.outline,
				},
				{
					id: "link-floorplan",
					artifactId: IMAGE_ARTIFACT.id,
					name: IMAGE_ARTIFACT.name,
					type: "source_document",
					mimeType: IMAGE_ARTIFACT.mimeType,
					sizeBytes: IMAGE_ARTIFACT.sizeBytes,
					conversationId,
					messageId: "capture-user-1",
					createdAt: sentAt,
				},
			],
		},
		{
			id: "capture-assistant-1",
			role: "assistant",
			content:
				"Yes — the break clause lets either party end the lease early, but only after the first twelve months and with six months' written notice. Serving notice on 1 October would end the lease on 31 March, and the landlord can still recover the service charge for that period.",
			timestamp: sentAt + 14_000,
			isStreaming: false,
			modelDisplayName: "Flash-Next",
			generationDurationMs: 9_400,
			thinking:
				"The user is asking about the break clause. The Invoice reply skill applies to the tone; a quick web check on notice periods is worth it.",
			thinkingSegments: [
				{
					type: "tool_call",
					callId: "call-skill",
					name: "use_skill",
					input: { displayName: "Invoice reply" },
					status: "done",
				},
				{
					type: "tool_call",
					callId: "call-web",
					name: "research_web",
					input: { query: "commercial lease break clause notice period" },
					status: "done",
				},
			],
			responseActivity: [
				{
					id: "act-skill",
					kind: "tool",
					status: "done",
					toolName: "use_skill",
					label: "Invoice reply",
					callId: "call-skill",
				},
				{
					id: "act-web",
					kind: "tool",
					status: "done",
					toolName: "research_web",
					label: "Web search",
					sourceType: "web",
					callId: "call-web",
				},
			],
		},
	];
}

async function mockStreamDetail(page: Page, conversationId: string) {
	await page.route(
		(url) => url.pathname === `/api/conversations/${conversationId}`,
		async (route) => {
			if (route.request().method() !== "GET") {
				await route.continue();
				return;
			}
			const response = await route.fetch();
			const json = (await response.json()) as Record<string, unknown>;
			json.messages = streamFixtureMessages(conversationId);
			json.bootstrap = false;
			await route.fulfill({ response, json });
		},
	);
}

async function navigateClientSide(page: Page, href: string) {
	// The link must be handled by SvelteKit's client router, or the load runs
	// on the server and the patched detail response never happens. The
	// composer's file input is disabled until hydration, so it doubles as the
	// "router is attached" signal.
	await expect(page.locator('input[type="file"]')).toBeEnabled({
		timeout: 30000,
	});
	await page.evaluate((next) => {
		const anchor = document.createElement("a");
		anchor.href = next;
		anchor.textContent = "capture";
		document.body.appendChild(anchor);
		anchor.click();
	}, href);
}

async function bootstrap(page: Page, theme: "light" | "dark") {
	await login(page);
	await setTheme(page, theme);
	await setAdminConfig(page, {
		COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
		ATLAS_WORKER_ENABLED: "true",
		PARALLEL_API_KEY: "fake-chips-capture-key",
		MAX_MESSAGE_LENGTH: "1048576",
	});
	const routes = await mockChipRoutes(page);
	const composerId = await createConversation(page, "Composer chips");
	const streamId = await createConversation(page, "Break clause");
	await mockStreamDetail(page, streamId);
	await page.goto(`/chat/${composerId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 20000,
	});
	await expect
		.poll(async () =>
			page.evaluate(() => document.documentElement.classList.contains("dark")),
		)
		.toBe(theme === "dark");
	await settle(page);
	return { routes, composerId, streamId };
}

async function dismissDegradedBanner(page: Page) {
	const dismiss = page.getByRole("button", { name: "Dismiss" }).first();
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click();
		await settle(page);
	}
}

async function captureComposer(
	page: Page,
	w: string,
	queue: (artifact: UploadArtifact) => void,
	profile: RegExp,
) {
	await dismissDegradedBanner(page);
	// 1. The Atlas chip alone — warning tint, profile in the meta, bell beside.
	await pickAtlasProfile(page, profile);
	await settle(page);
	await shotComposer(page, `${w}-composer-atlas`, 120);
	await page.screenshot({ path: `${OUT}/${w}-composer-atlas-full.png` });
	await page.getByRole("button", { name: "Remove Atlas" }).click();
	await expect(page.getByTestId("composer-chip-atlas")).toHaveCount(0);

	// 2. Skill + image + file in the one row.
	await addSkillChip(page);
	await attach(page, queue, IMAGE_ARTIFACT, THUMB_PNG);
	await attach(page, queue, PDF_ARTIFACT, Buffer.from("%PDF-1.4"));
	await page
		.getByTestId("message-input")
		.fill("Draft a reply to the landlord about the break clause.");
	await settle(page);
	await shotComposer(page, `${w}-composer-skill-image-file`, 120);
	await page.screenshot({
		path: `${OUT}/${w}-composer-skill-image-file-full.png`,
	});
}

async function captureStream(page: Page, w: string, streamId: string) {
	await navigateClientSide(page, `/chat/${streamId}`);
	const user = page.getByTestId("user-message").first();
	const assistant = page.getByTestId("assistant-message").first();
	// The provenance line is the assistant turn's FOOTER — a sibling of the
	// bubble that carries the test id, not a child of it.
	const provenance = page.getByTestId("message-provenance").first();
	await expect(assistant).toBeVisible({ timeout: 20000 });
	await expect(provenance).toBeVisible({ timeout: 20000 });
	await expect(user.getByTestId("user-bubble-quote-chip")).toBeVisible();
	await dismissDegradedBanner(page);
	await settle(page);
	await page.screenshot({ path: `${OUT}/${w}-stream.png` });
	await user.screenshot({ path: `${OUT}/${w}-stream-user-bubble.png` });

	// Bubble + footer together: from the top of the answer to just under the
	// provenance line's action row.
	await assistant.hover();
	await settle(page);
	const bubbleBox = await assistant.boundingBox();
	const lineBox = await provenance.boundingBox();
	const viewport = page.viewportSize();
	if (!bubbleBox || !lineBox || !viewport) {
		throw new Error(`assistant turn not measurable for ${w}`);
	}
	const x = Math.max(0, Math.min(bubbleBox.x, lineBox.x) - 12);
	const y = Math.max(0, bubbleBox.y - 12);
	await page.screenshot({
		path: `${OUT}/${w}-stream-assistant-provenance.png`,
		clip: {
			x,
			y,
			width: Math.min(
				viewport.width - x,
				Math.max(bubbleBox.x + bubbleBox.width, lineBox.x + lineBox.width) -
					x +
					12,
			),
			height: Math.min(
				viewport.height - y,
				lineBox.y + lineBox.height - y + 56,
			),
		},
	});
}

for (const theme of ["light", "dark"] as const) {
	test.describe(`desktop ${theme}`, () => {
		test.use({ viewport: DESKTOP });

		test("composer and stream chips", async ({ page }) => {
			test.setTimeout(180_000);
			const { routes, composerId, streamId } = await bootstrap(page, theme);
			const w = `1280-${theme}`;
			await captureStream(page, w, streamId);
			await navigateClientSide(page, `/chat/${composerId}`);
			await expect(page.getByTestId("user-message")).toHaveCount(0);
			await captureComposer(page, w, routes.queueUpload, /In-Depth/i);
		});
	});

	test.describe(`phone ${theme}`, () => {
		test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

		test("composer and stream chips", async ({ page }) => {
			test.setTimeout(180_000);
			const { routes, composerId, streamId } = await bootstrap(page, theme);
			const w = `390-${theme}`;
			await captureStream(page, w, streamId);
			await navigateClientSide(page, `/chat/${composerId}`);
			await expect(page.getByTestId("user-message")).toHaveCount(0);
			// At 390px the profile sheet shows only its first card inside the
			// viewport; Overview is the one a finger can reach without scrolling.
			await captureComposer(page, w, routes.queueUpload, /Overview/i);
		});
	});
}
