import { expect, type Page } from "@playwright/test";

import { openConversationComposer } from "./helpers";

const KNOWLEDGE_ROUTE_GLOB = "**/api/knowledge/**";
// The client upload path is a two-step protocol: POST /upload/intent (returns a
// traceId + body limits) then, for small files, POST /upload/raw (returns the
// KnowledgeUploadResponse). The former single-shot /api/knowledge/upload
// endpoint no longer exists, so both steps must be mocked.
const KNOWLEDGE_UPLOAD_INTENT_GLOB = "**/api/knowledge/upload/intent";
const KNOWLEDGE_UPLOAD_RAW_GLOB = "**/api/knowledge/upload/raw";
const TEST_ARTIFACT_ID = "test-artifact-id";

type MockAttachmentContentOptions = {
	artifactName: string;
	contentText: string | null;
	status?: number;
	error?: string;
};

type MockAttachmentUploadOptions = {
	artifactName: string;
	buffer: Buffer;
	promptReady?: boolean;
	promptArtifactId?: string | null;
};

type PrepareAttachmentConversationOptions = MockAttachmentContentOptions &
	MockAttachmentUploadOptions & {
		message?: string;
	};

function isAttachmentContentRequest(url: string) {
	return url.includes("/api/knowledge/") && !url.includes("/upload");
}

function isPreviewRequest(url: string) {
	return url.includes("/api/knowledge/") && url.includes("/preview");
}

export async function mockAttachmentContentRoute(
	page: Page,
	options: MockAttachmentContentOptions,
) {
	await page.route(KNOWLEDGE_ROUTE_GLOB, async (route) => {
		const url = route.request().url();
		if (!isAttachmentContentRequest(url)) {
			await route.continue();
			return;
		}

		// The document workspace previews the artifact via /preview, which
		// returns the raw file body (not JSON).
		if (isPreviewRequest(url)) {
			if (options.status && options.status !== 200) {
				await route.fulfill({
					status: options.status,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						error: options.error ?? "Artifact not found",
					}),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
				body: options.contentText ?? "",
			});
			return;
		}

		if (options.status && options.status !== 200) {
			await route.fulfill({
				status: options.status,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ error: options.error ?? "Artifact not found" }),
			});
			return;
		}

		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				artifact: {
					id: TEST_ARTIFACT_ID,
					name: options.artifactName,
					contentText: options.contentText,
				},
				links: [],
			}),
		});
	});
}

export async function mockAttachmentUploadRoute(
	page: Page,
	options: MockAttachmentUploadOptions,
) {
	// Step 1: intent handshake. Returning no body limits makes the client take
	// the single-shot /upload/raw path for the tiny test buffers.
	await page.route(KNOWLEDGE_UPLOAD_INTENT_GLOB, async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ traceId: "test-trace-id" }),
		});
	});

	// Step 2: raw body upload → the KnowledgeUploadResponse the composer consumes.
	await page.route(KNOWLEDGE_UPLOAD_RAW_GLOB, async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				artifact: {
					id: TEST_ARTIFACT_ID,
					type: "source_document",
					retrievalClass: "durable",
					name: options.artifactName,
					mimeType: "text/plain",
					sizeBytes: 1024,
					conversationId: null,
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				normalizedArtifact: null,
				reusedExistingArtifact: false,
				honcho: { uploaded: false, mode: "none" },
				promptReady: options.promptReady ?? true,
				promptArtifactId:
					options.promptArtifactId ??
					((options.promptReady ?? true) ? TEST_ARTIFACT_ID : null),
				readinessError: null,
			}),
		});
	});
}

export async function prepareAttachmentConversation(
	page: Page,
	options: PrepareAttachmentConversationOptions,
) {
	await mockAttachmentContentRoute(page, options);
	await page.goto("/");
	await openConversationComposer(page);
	await mockAttachmentUploadRoute(page, options);

	await page.locator('input[type="file"]').setInputFiles({
		name: options.artifactName,
		mimeType: "text/plain",
		buffer: options.buffer,
	});

	await expect(page.locator(".file-attachment")).toBeVisible({
		timeout: 10000,
	});

	if (options.message) {
		await page.getByTestId("message-input").fill(options.message);
		await page.getByTestId("send-button").click();
		await expect(page.getByTestId("user-message").first()).toContainText(
			options.message,
			{ timeout: 10000 },
		);
	}
}

// The former attachment content modal was replaced by the document workspace:
// clicking an attachment in a sent message opens the workspace side panel
// (aria-label "Document workspace") and previews the artifact there. This opens
// that workspace and returns its locator.
export async function openAttachmentWorkspace(page: Page) {
	await page.locator(".file-attachment").first().click();
	// Wait for the workspace content region, then return the whole desktop
	// workspace panel (its header carries the filename, its body the content).
	await page
		.getByTestId("workspace-main")
		.waitFor({ state: "visible", timeout: 10000 });
	const workspace = page
		.getByRole("complementary", { name: "Document workspace" })
		.first();
	await workspace.waitFor({ state: "visible", timeout: 10000 });
	return workspace;
}

export async function closeAttachmentWorkspace(page: Page) {
	await page
		.getByRole("button", { name: "Close document workspace" })
		.first()
		.click();
}
