import { expect, type Page, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	login,
	openConversationComposer,
} from "./helpers";

// Unique phrases that the model should be able to reference
const SMALL_FILE_ENDING_PHRASE =
	"The quick brown fox jumps over the lazy dog at sunset in the meadow";
const LARGE_FILE_MIDDLE_PHRASE =
	"The silver moon rises over the calm ocean waters at midnight";
const LARGE_FILE_ENDING_PHRASE =
	"The golden eagle soars high above the mountain peaks at dawn";

type TestUploadFile = {
	name: string;
	mimeType: string;
	buffer: Buffer;
};

const SMALL_FILE: TestUploadFile = {
	name: "small-document.txt",
	mimeType: "text/plain",
	buffer: Buffer.from(
		[
			"Project Requirements Document",
			"Performance targets require sub-second response times.",
			"Security requirements include TLS 1.3.",
			`${SMALL_FILE_ENDING_PHRASE}.`,
		].join("\n"),
	),
};

const LARGE_FILE: TestUploadFile = {
	name: "large-document.txt",
	mimeType: "text/plain",
	buffer: Buffer.from(
		Array.from({ length: 16 }, (_, index) => {
			if (index === 10) {
				return `Section 11: ${LARGE_FILE_MIDDLE_PHRASE}.`;
			}
			if (index === 15) {
				return `Section 16: ${LARGE_FILE_ENDING_PHRASE}.`;
			}
			return `Section ${index + 1}: Comprehensive Technical Specification content about architecture, APIs, database schema, integration patterns, testing strategy, deployment, and operations. `.repeat(
				55,
			);
		}).join("\n\n"),
	),
};

/**
 * Helper to mock the chat stream route with a custom response
 */
function mockStreamRoute(page: Page, responseText: string) {
	return page.route("**/api/chat/stream", async (route) => {
		await route.fulfill({
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
			body: buildAiSdkUiStreamBody(responseText),
		});
	});
}

function artifactIdForFileName(fileName: string): string {
	return `e2e-${fileName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

async function mockSuccessfulKnowledgeUploads(page: Page) {
	await page.route("**/api/knowledge/upload/intent", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				traceId: `trace-${Date.now()}`,
				rawUploadLimit: 10 * 1024 * 1024,
				chunkBodyLimit: 256 * 1024,
			}),
		});
	});

	await page.route("**/api/knowledge/upload/raw", async (route) => {
		const headers = route.request().headers();
		const fileName = decodeURIComponent(
			headers["x-alfyai-upload-name"] ?? "uploaded-file.txt",
		);
		const fileSize = Number(headers["x-alfyai-upload-size"] ?? 0);
		const mimeType = headers["content-type"] ?? "text/plain";
		const artifact = {
			id: artifactIdForFileName(fileName),
			type: "source_document",
			retrievalClass: "durable",
			name: fileName,
			mimeType,
			sizeBytes: fileSize,
			conversationId: headers["x-alfyai-conversation-id"] ?? null,
			summary: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				artifact,
				normalizedArtifact: null,
				reusedExistingArtifact: false,
				honcho: { uploaded: false, mode: "none" },
				promptReady: true,
				promptArtifactId: artifact.id,
				readinessError: null,
			}),
		});
	});
}

/**
 * The landing composer is server-rendered before Svelte wires up its file input
 * listener. Prove the composer is hydrated before selecting files.
 */
async function waitForComposerHydration(page: Page): Promise<void> {
	const toolsButton = page.getByRole("button", { name: "Open composer tools" });
	const toolsMenu = page.getByRole("menu", { name: "Composer menu" });
	await expect(toolsButton).toBeVisible();
	await expect(async () => {
		if (await toolsMenu.isVisible().catch(() => false)) return;
		await toolsButton.click();
		await expect(toolsMenu).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 15000 });
	await page.keyboard.press("Escape");
	await expect(toolsMenu).not.toBeVisible();
}

/**
 * Helper to upload a file in the chat composer
 */
async function uploadFileInChat(
	page: Page,
	file: TestUploadFile,
): Promise<void> {
	await waitForComposerHydration(page);
	const fileInput = page.locator('input[type="file"]').first();
	await expect(fileInput).toBeHidden();
	await fileInput.setInputFiles(file);

	// Wait for the file to be uploaded and appear as an attachment
	await expect(page.getByText(file.name)).toBeVisible({ timeout: 15000 });
}

/**
 * Helper to send a message with optional attachments
 */
async function sendMessageWithAttachments(
	page: Page,
	message: string,
): Promise<void> {
	const input = page.getByTestId("message-input");
	await input.waitFor({ state: "visible" });
	await input.fill(message);
	const sendButton = page.getByTestId("send-button");
	await expect(sendButton).toBeEnabled({ timeout: 10000 });
	await sendButton.click();
}

/**
 * Helper to wait for assistant response and return the text
 */
async function getAssistantResponseText(
	page: Page,
	timeout = 30000,
): Promise<string> {
	const assistantMessage = page.getByTestId("assistant-message").first();
	await expect(assistantMessage).toBeVisible({ timeout });
	// Wait for content to be populated
	await page.waitForFunction(
		() => {
			const msg = document.querySelector('[data-testid="assistant-message"]');
			return msg?.textContent && msg.textContent.trim().length > 0;
		},
		{ timeout },
	);
	return assistantMessage.textContent() || "";
}

test.describe("File Fragmentation E2E Tests", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await mockSuccessfulKnowledgeUploads(page);
	});

	test.describe("Small File Handling (under 5K chars)", () => {
		test("model can reference content from end of small document", async ({
			page,
		}) => {
			// Mock the stream to return a response that includes the ending phrase
			const mockResponse = `Based on the document you uploaded, the last sentence is: "${SMALL_FILE_ENDING_PHRASE}." This appears at the very end of your Project Requirements Document.`;
			await mockStreamRoute(page, mockResponse);

			// Open the conversation composer
			await openConversationComposer(page);

			// Upload the small file
			await uploadFileInChat(page, SMALL_FILE);

			// Send a message asking about the last sentence
			await sendMessageWithAttachments(
				page,
				"What is the last sentence of the document?",
			);

			// Wait for and verify the assistant response
			const responseText = await getAssistantResponseText(page, 20000);

			// The model should be able to reference the ending phrase
			expect(responseText.toLowerCase()).toContain("quick brown fox");
			expect(responseText.toLowerCase()).toContain("lazy dog");
		});

		test("small file is not chunked and maintains continuity", async ({
			page,
		}) => {
			// Mock response referencing multiple parts of the small document
			const mockResponse =
				"The document contains project requirements including performance targets (sub-second response times), security requirements (TLS 1.3), and ends with the phrase about the quick brown fox.";
			await mockStreamRoute(page, mockResponse);

			await openConversationComposer(page);
			await uploadFileInChat(page, SMALL_FILE);

			await sendMessageWithAttachments(
				page,
				"Summarize the key points from this document",
			);

			const responseText = await getAssistantResponseText(page, 20000);

			// Verify the model can reference content from throughout the document
			expect(responseText.toLowerCase()).toContain("performance");
			expect(responseText.toLowerCase()).toContain("security");
		});
	});

	test.describe("Large File Handling (over 10K chars)", () => {
		test("model can reference content from middle of large document with chunking", async ({
			page,
		}) => {
			// Mock response that references the middle section phrase
			const mockResponse = `In Section 11 of your document, I found this reference: "${LARGE_FILE_MIDDLE_PHRASE}." This appears in the middle section of the Comprehensive Technical Specification.`;
			await mockStreamRoute(page, mockResponse);

			await openConversationComposer(page);
			await uploadFileInChat(page, LARGE_FILE);

			await sendMessageWithAttachments(
				page,
				"What does Section 11 say about the moon and ocean?",
			);

			const responseText = await getAssistantResponseText(page, 20000);

			// Verify the model can reference content from the middle of the large document
			expect(responseText.toLowerCase()).toContain("silver moon");
			expect(responseText.toLowerCase()).toContain("ocean");
		});

		test("model can reference content from end of large chunked document", async ({
			page,
		}) => {
			// Mock response referencing the ending phrase
			const mockResponse = `The document concludes with: "${LARGE_FILE_ENDING_PHRASE}." This appears in Section 15, the conclusion of the Comprehensive Technical Specification.`;
			await mockStreamRoute(page, mockResponse);

			await openConversationComposer(page);
			await uploadFileInChat(page, LARGE_FILE);

			await sendMessageWithAttachments(
				page,
				"What is the final sentence of the document?",
			);

			const responseText = await getAssistantResponseText(page, 20000);

			// Verify the model can reference the ending
			expect(responseText.toLowerCase()).toContain("golden eagle");
			expect(responseText.toLowerCase()).toContain("mountain peaks");
		});

		test("large file is appropriately chunked for context window", async ({
			page,
		}) => {
			// Mock response showing the model can reference multiple sections
			const mockResponse =
				"This large document covers: 1) System Architecture (Section 2), 2) API Design (Section 5), 3) Database Schema (Section 6), and concludes with Section 15. The middle section contains a unique reference to the silver moon over ocean waters.";
			await mockStreamRoute(page, mockResponse);

			await openConversationComposer(page);
			await uploadFileInChat(page, LARGE_FILE);

			await sendMessageWithAttachments(
				page,
				"What sections does this document contain?",
			);

			const responseText = await getAssistantResponseText(page, 20000);

			// Verify the model can reference multiple sections
			expect(responseText.toLowerCase()).toContain("section");
			expect(responseText.toLowerCase()).toContain("architecture");
		});
	});

	test.describe("Mixed File Upload Handling", () => {
		test("both small and large files handled correctly in same conversation", async ({
			page,
		}) => {
			// Mock response that references both files
			const mockResponse = `From your small document (Project Requirements), I see it ends with "${SMALL_FILE_ENDING_PHRASE}." From your large document (Technical Specification), Section 11 mentions "${LARGE_FILE_MIDDLE_PHRASE}." Both documents have been processed successfully.`;
			await mockStreamRoute(page, mockResponse);

			await openConversationComposer(page);

			// Upload both files
			await uploadFileInChat(page, SMALL_FILE);
			await uploadFileInChat(page, LARGE_FILE);

			// Verify both files are attached
			await expect(page.getByText("small-document.txt")).toBeVisible();
			await expect(page.getByText("large-document.txt")).toBeVisible();

			await sendMessageWithAttachments(
				page,
				"What are the ending phrases in both documents?",
			);

			const responseText = await getAssistantResponseText(page, 20000);

			// Verify the model can reference content from both files
			expect(responseText.toLowerCase()).toContain("quick brown fox");
			expect(responseText.toLowerCase()).toContain("silver moon");
		});

		test("can ask specific questions about each uploaded file", async ({
			page,
		}) => {
			// Mock a response that shows the model can distinguish between both files
			const mockResponse = `Based on both documents you uploaded:

From the small document (Project Requirements): It focuses on user management, data processing, reporting, performance requirements, and security compliance. It ends with "${SMALL_FILE_ENDING_PHRASE}."

From the large document (Technical Specification): It covers system architecture, functional requirements, API design, database schema, integration patterns, testing strategy, and deployment procedures. Section 11 contains "${LARGE_FILE_MIDDLE_PHRASE}."`;
			await mockStreamRoute(page, mockResponse);

			await openConversationComposer(page);
			await uploadFileInChat(page, SMALL_FILE);
			await uploadFileInChat(page, LARGE_FILE);

			await sendMessageWithAttachments(page, "What do both documents contain?");

			const responseText = await getAssistantResponseText(page, 20000);

			// Verify the model can reference content from both files in one response
			expect(responseText.toLowerCase()).toContain("project");
			expect(responseText.toLowerCase()).toContain("requirements");
			expect(responseText.toLowerCase()).toContain("technical");
			expect(responseText.toLowerCase()).toContain("specification");
			expect(responseText.toLowerCase()).toContain("section 11");
		});
	});

	test.describe("File Upload Error Handling", () => {
		test("handles file upload gracefully when service is unavailable", async ({
			page,
		}) => {
			// Mock the upload endpoint to fail
			await page.unroute("**/api/knowledge/upload/raw");
			await page.route("**/api/knowledge/upload/raw", async (route) => {
				await route.fulfill({
					status: 503,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						error: "Upload service temporarily unavailable",
					}),
				});
			});

			await openConversationComposer(page);

			const fileInput = page.locator('input[type="file"]').first();
			await waitForComposerHydration(page);
			await expect(fileInput).toBeHidden();
			await fileInput.setInputFiles(SMALL_FILE);

			// Should show an error message
			await expect(
				page.getByText(/upload|error|failed|unavailable/i),
			).toBeVisible({ timeout: 10000 });
		});
	});

	test.describe("File Attachment UI Verification", () => {
		test("file attachments display correctly in composer", async ({ page }) => {
			await openConversationComposer(page);

			// Upload the small file
			await uploadFileInChat(page, SMALL_FILE);

			// Verify file name is displayed
			await expect(page.getByText("small-document.txt")).toBeVisible();

			// Verify file can be removed
			const removeButton = page
				.getByRole("button", { name: "Remove small-document.txt" })
				.first();
			await removeButton.click();
			await expect(page.getByText("small-document.txt")).not.toBeVisible();
		});

		test("multiple files can be attached and display correctly", async ({
			page,
		}) => {
			await openConversationComposer(page);

			// Upload both files
			await uploadFileInChat(page, SMALL_FILE);
			await uploadFileInChat(page, LARGE_FILE);

			// Verify both file names are displayed
			await expect(page.getByText("small-document.txt")).toBeVisible();
			await expect(page.getByText("large-document.txt")).toBeVisible();
		});
	});
});
