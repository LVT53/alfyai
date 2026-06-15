import { expect, test } from "@playwright/test";

import {
	openAttachmentModal,
	prepareAttachmentConversation,
} from "./attachment-modal.helpers";
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
		await prepareAttachmentConversation(page, {
			artifactName: "test-document.txt",
			contentText: MOCK_ATTACHMENT_CONTENT,
			buffer: Buffer.from("Test file content"),
			message: "Message with attachment",
		});

		const dialog = await openAttachmentModal(page);
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await expect(dialog).toContainText("test-document.txt");
		await expect(page.locator("pre.content-text")).toContainText(
			MOCK_ATTACHMENT_CONTENT,
		);
	});

	test("modal displays empty state when contentText is null", async ({
		page,
	}) => {
		await prepareAttachmentConversation(page, {
			artifactName: "empty-document.txt",
			contentText: null,
			buffer: Buffer.from(""),
			message: "Message with empty attachment",
		});

		const dialog = await openAttachmentModal(page);
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await expect(dialog).toContainText("No extracted text available");
	});

	test("modal displays error state on API failure", async ({ page }) => {
		await prepareAttachmentConversation(page, {
			artifactName: "missing-document.txt",
			contentText: null,
			status: 404,
			buffer: Buffer.from("Test content"),
			message: "Message with missing attachment",
		});

		const dialog = await openAttachmentModal(page);
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await expect(dialog).toContainText("Failed to load");
	});

	test("modal closes on Escape key press", async ({ page }) => {
		await prepareAttachmentConversation(page, {
			artifactName: "test-document.txt",
			contentText: MOCK_ATTACHMENT_CONTENT,
			buffer: Buffer.from("Test content"),
			message: "Test message",
		});

		const dialog = await openAttachmentModal(page);
		await expect(dialog).toBeVisible({ timeout: 5000 });

		await page.keyboard.press("Escape");

		await expect(dialog).not.toBeVisible({ timeout: 5000 });
	});

	test("modal closes on backdrop click", async ({ page }) => {
		await prepareAttachmentConversation(page, {
			artifactName: "test-document.txt",
			contentText: MOCK_ATTACHMENT_CONTENT,
			buffer: Buffer.from("Test content"),
			message: "Test message",
		});

		const dialog = await openAttachmentModal(page);
		await expect(dialog).toBeVisible({ timeout: 5000 });

		await page
			.locator(".fixed.inset-0")
			.first()
			.click({ position: { x: 10, y: 10 } });

		await expect(dialog).not.toBeVisible({ timeout: 5000 });
	});

	test("XSS content is rendered as plain text, not executed", async ({
		page,
	}) => {
		await prepareAttachmentConversation(page, {
			artifactName: "xss-test.txt",
			contentText: MOCK_XSS_CONTENT,
			buffer: Buffer.from("XSS test content"),
			message: "XSS test message",
		});

		const dialog = await openAttachmentModal(page);
		await expect(dialog).toBeVisible({ timeout: 5000 });

		const contentText = await page.locator("pre.content-text").textContent();
		expect(contentText).toContain('<script>alert("XSS")</script>');
		expect(contentText).toContain("<img src=x onerror=alert(1)>");
		expect(contentText).toContain("Plain text");

		await expect(page.locator("pre.content-text")).toBeVisible();
	});

	test("attachment in composer is not clickable when promptReady is false", async ({
		page,
	}) => {
		await prepareAttachmentConversation(page, {
			artifactName: "processing-document.txt",
			contentText: null,
			promptReady: false,
			buffer: Buffer.from("Test content"),
		});

		const attachment = page.locator(".file-attachment").first();
		await expect(attachment).not.toHaveClass(/viewable/);
	});
});
