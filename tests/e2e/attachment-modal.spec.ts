import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const MOCK_ATTACHMENT_CONTENT =
	"This is the extracted text content from the uploaded file.";
const MOCK_XSS_CONTENT =
	'<script>alert("XSS")</script><img src=x onerror=alert(1)>Plain text';

test.describe("Attachment Content Modal", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("clicking attachment in sent message opens modal with content", async ({
		page,
	}) => {
		// Mock the knowledge API to return attachment content
		await page.route("**/api/knowledge/**", async (route) => {
			const url = route.request().url();
			if (url.includes("/api/knowledge/") && !url.includes("/upload")) {
				await route.fulfill({
					status: 200,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						artifact: {
							id: "test-artifact-id",
							name: "test-document.txt",
							contentText: MOCK_ATTACHMENT_CONTENT,
						},
						links: [],
					}),
				});
				return;
			}
			await route.continue();
		});

		// Create a conversation with an attachment
		await page.goto("/");
		await page.getByTestId("new-conversation").click();
		await expect(page).toHaveURL("/", { timeout: 10000 });

		// Mock the upload response
		await page.route("**/api/knowledge/upload", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					artifact: {
						id: "test-artifact-id",
						type: "source_document",
						retrievalClass: "durable",
						name: "test-document.txt",
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
					promptReady: true,
					promptArtifactId: "test-artifact-id",
					readinessError: null,
				}),
			});
		});

		// Upload a file
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "test-document.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Test file content"),
		});

		// Wait for the attachment to appear
		await expect(page.locator(".file-attachment")).toBeVisible({
			timeout: 10000,
		});

		// Send a message
		await page.getByTestId("message-input").fill("Message with attachment");
		await page.getByTestId("send-button").click();

		// Wait for the user message to appear
		await expect(page.getByTestId("user-message").first()).toContainText(
			"Message with attachment",
			{ timeout: 10000 },
		);

		// Click on the attachment in the sent message
		await page.locator(".file-attachment").first().click();

		// Verify the modal opens with the content
		await expect(page.locator('[role="dialog"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[role="dialog"]')).toContainText(
			"test-document.txt",
		);
		await expect(page.locator("pre.content-text")).toContainText(
			MOCK_ATTACHMENT_CONTENT,
		);
	});

	test("modal displays empty state when contentText is null", async ({
		page,
	}) => {
		// Mock the knowledge API to return null content
		await page.route("**/api/knowledge/**", async (route) => {
			const url = route.request().url();
			if (url.includes("/api/knowledge/") && !url.includes("/upload")) {
				await route.fulfill({
					status: 200,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						artifact: {
							id: "test-artifact-id",
							name: "empty-document.txt",
							contentText: null,
						},
						links: [],
					}),
				});
				return;
			}
			await route.continue();
		});

		// Create a conversation
		await page.goto("/");
		await page.getByTestId("new-conversation").click();

		// Mock the upload response
		await page.route("**/api/knowledge/upload", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					artifact: {
						id: "test-artifact-id",
						type: "source_document",
						retrievalClass: "durable",
						name: "empty-document.txt",
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
					promptReady: true,
					promptArtifactId: "test-artifact-id",
					readinessError: null,
				}),
			});
		});

		// Upload a file
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "empty-document.txt",
			mimeType: "text/plain",
			buffer: Buffer.from(""),
		});

		await expect(page.locator(".file-attachment")).toBeVisible({
			timeout: 10000,
		});

		// Send a message
		await page
			.getByTestId("message-input")
			.fill("Message with empty attachment");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("user-message").first()).toContainText(
			"Message with empty attachment",
			{ timeout: 10000 },
		);

		// Click on the attachment
		await page.locator(".file-attachment").first().click();

		// Verify the modal shows empty state message
		await expect(page.locator('[role="dialog"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[role="dialog"]')).toContainText(
			"No extracted text available",
		);
	});

	test("modal displays error state on API failure", async ({ page }) => {
		// Mock the knowledge API to return 404
		await page.route("**/api/knowledge/**", async (route) => {
			const url = route.request().url();
			if (url.includes("/api/knowledge/") && !url.includes("/upload")) {
				await route.fulfill({
					status: 404,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ error: "Artifact not found" }),
				});
				return;
			}
			await route.continue();
		});

		// Create a conversation
		await page.goto("/");
		await page.getByTestId("new-conversation").click();

		// Mock the upload response
		await page.route("**/api/knowledge/upload", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					artifact: {
						id: "test-artifact-id",
						type: "source_document",
						retrievalClass: "durable",
						name: "missing-document.txt",
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
					promptReady: true,
					promptArtifactId: "test-artifact-id",
					readinessError: null,
				}),
			});
		});

		// Upload a file
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "missing-document.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Test content"),
		});

		await expect(page.locator(".file-attachment")).toBeVisible({
			timeout: 10000,
		});

		// Send a message
		await page
			.getByTestId("message-input")
			.fill("Message with missing attachment");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("user-message").first()).toContainText(
			"Message with missing attachment",
			{ timeout: 10000 },
		);

		// Click on the attachment
		await page.locator(".file-attachment").first().click();

		// Verify the modal shows error state
		await expect(page.locator('[role="dialog"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[role="dialog"]')).toContainText(
			"Failed to load",
		);
	});

	test("modal closes on Escape key press", async ({ page }) => {
		// Mock the knowledge API
		await page.route("**/api/knowledge/**", async (route) => {
			const url = route.request().url();
			if (url.includes("/api/knowledge/") && !url.includes("/upload")) {
				await route.fulfill({
					status: 200,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						artifact: {
							id: "test-artifact-id",
							name: "test-document.txt",
							contentText: MOCK_ATTACHMENT_CONTENT,
						},
						links: [],
					}),
				});
				return;
			}
			await route.continue();
		});

		// Create a conversation
		await page.goto("/");
		await page.getByTestId("new-conversation").click();

		// Mock the upload response
		await page.route("**/api/knowledge/upload", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					artifact: {
						id: "test-artifact-id",
						type: "source_document",
						retrievalClass: "durable",
						name: "test-document.txt",
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
					promptReady: true,
					promptArtifactId: "test-artifact-id",
					readinessError: null,
				}),
			});
		});

		// Upload a file
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "test-document.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Test content"),
		});

		await expect(page.locator(".file-attachment")).toBeVisible({
			timeout: 10000,
		});

		// Send a message
		await page.getByTestId("message-input").fill("Test message");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("user-message").first()).toContainText(
			"Test message",
			{ timeout: 10000 },
		);

		// Click on the attachment to open modal
		await page.locator(".file-attachment").first().click();
		await expect(page.locator('[role="dialog"]')).toBeVisible({
			timeout: 5000,
		});

		// Press Escape to close
		await page.keyboard.press("Escape");

		// Verify modal is closed
		await expect(page.locator('[role="dialog"]')).not.toBeVisible({
			timeout: 5000,
		});
	});

	test("modal closes on backdrop click", async ({ page }) => {
		// Mock the knowledge API
		await page.route("**/api/knowledge/**", async (route) => {
			const url = route.request().url();
			if (url.includes("/api/knowledge/") && !url.includes("/upload")) {
				await route.fulfill({
					status: 200,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						artifact: {
							id: "test-artifact-id",
							name: "test-document.txt",
							contentText: MOCK_ATTACHMENT_CONTENT,
						},
						links: [],
					}),
				});
				return;
			}
			await route.continue();
		});

		// Create a conversation
		await page.goto("/");
		await page.getByTestId("new-conversation").click();

		// Mock the upload response
		await page.route("**/api/knowledge/upload", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					artifact: {
						id: "test-artifact-id",
						type: "source_document",
						retrievalClass: "durable",
						name: "test-document.txt",
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
					promptReady: true,
					promptArtifactId: "test-artifact-id",
					readinessError: null,
				}),
			});
		});

		// Upload a file
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "test-document.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Test content"),
		});

		await expect(page.locator(".file-attachment")).toBeVisible({
			timeout: 10000,
		});

		// Send a message
		await page.getByTestId("message-input").fill("Test message");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("user-message").first()).toContainText(
			"Test message",
			{ timeout: 10000 },
		);

		// Click on the attachment to open modal
		await page.locator(".file-attachment").first().click();
		await expect(page.locator('[role="dialog"]')).toBeVisible({
			timeout: 5000,
		});

		// Click on the backdrop (outside the modal)
		await page
			.locator(".fixed.inset-0")
			.first()
			.click({ position: { x: 10, y: 10 } });

		// Verify modal is closed
		await expect(page.locator('[role="dialog"]')).not.toBeVisible({
			timeout: 5000,
		});
	});

	test("XSS content is rendered as plain text, not executed", async ({
		page,
	}) => {
		// Mock the knowledge API to return XSS content
		await page.route("**/api/knowledge/**", async (route) => {
			const url = route.request().url();
			if (url.includes("/api/knowledge/") && !url.includes("/upload")) {
				await route.fulfill({
					status: 200,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						artifact: {
							id: "test-artifact-id",
							name: "xss-test.txt",
							contentText: MOCK_XSS_CONTENT,
						},
						links: [],
					}),
				});
				return;
			}
			await route.continue();
		});

		// Create a conversation
		await page.goto("/");
		await page.getByTestId("new-conversation").click();

		// Mock the upload response
		await page.route("**/api/knowledge/upload", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					artifact: {
						id: "test-artifact-id",
						type: "source_document",
						retrievalClass: "durable",
						name: "xss-test.txt",
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
					promptReady: true,
					promptArtifactId: "test-artifact-id",
					readinessError: null,
				}),
			});
		});

		// Upload a file
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "xss-test.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("XSS test content"),
		});

		await expect(page.locator(".file-attachment")).toBeVisible({
			timeout: 10000,
		});

		// Send a message
		await page.getByTestId("message-input").fill("XSS test message");
		await page.getByTestId("send-button").click();

		await expect(page.getByTestId("user-message").first()).toContainText(
			"XSS test message",
			{ timeout: 10000 },
		);

		// Click on the attachment
		await page.locator(".file-attachment").first().click();

		// Verify the modal opens
		await expect(page.locator('[role="dialog"]')).toBeVisible({
			timeout: 5000,
		});

		// Verify the XSS content is displayed as plain text
		const contentText = await page.locator("pre.content-text").textContent();
		expect(contentText).toContain('<script>alert("XSS")</script>');
		expect(contentText).toContain("<img src=x onerror=alert(1)>");
		expect(contentText).toContain("Plain text");

		// Verify no script tags were executed (no alerts)
		// The content should be in a <pre> tag, not rendered as HTML
		const preElement = page.locator("pre.content-text");
		await expect(preElement).toBeVisible();
	});

	test("attachment in composer is not clickable when promptReady is false", async ({
		page,
	}) => {
		// Create a conversation
		await page.goto("/");
		await page.getByTestId("new-conversation").click();

		// Mock the upload response with promptReady: false
		await page.route("**/api/knowledge/upload", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					artifact: {
						id: "test-artifact-id",
						type: "source_document",
						retrievalClass: "durable",
						name: "processing-document.txt",
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
					promptReady: false, // Not ready yet
					promptArtifactId: null,
					readinessError: null,
				}),
			});
		});

		// Upload a file
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "processing-document.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Test content"),
		});

		await expect(page.locator(".file-attachment")).toBeVisible({
			timeout: 10000,
		});

		// The attachment should not have the viewable class (no cursor-pointer)
		const attachment = page.locator(".file-attachment").first();
		await expect(attachment).not.toHaveClass(/viewable/);
	});
});
