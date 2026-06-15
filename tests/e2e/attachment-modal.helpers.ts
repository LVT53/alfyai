import { expect, type Page } from "@playwright/test";

import { openConversationComposer } from "./helpers";

const KNOWLEDGE_ROUTE_GLOB = "**/api/knowledge/**";
const KNOWLEDGE_UPLOAD_GLOB = "**/api/knowledge/upload";
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
	await page.route(KNOWLEDGE_UPLOAD_GLOB, async (route) => {
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

export async function openAttachmentModal(page: Page) {
	await page.locator(".file-attachment").first().click();
	return page.locator('[role="dialog"]');
}
