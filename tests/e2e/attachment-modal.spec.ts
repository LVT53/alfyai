import { expect, test } from "@playwright/test";

import {
	closeAttachmentWorkspace,
	openAttachmentWorkspace,
	prepareAttachmentConversation,
} from "./attachment-modal.helpers";
import { login } from "./helpers";

const MOCK_ATTACHMENT_CONTENT =
	"This is the extracted text content from the uploaded file.";
const MOCK_XSS_CONTENT =
	'<script>alert("XSS")</script><img src=x onerror=alert(1)>Plain text';

// The former attachment content modal was replaced by the document workspace.
// Clicking a viewable attachment in a sent message now opens the workspace side
// panel and previews the artifact there; these tests preserve the original
// intents (open + content, empty state, error state, close, XSS-as-text)
// against that contract.
test.describe("Attachment workspace preview", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("clicking attachment in sent message opens the workspace with content", async ({
		page,
	}) => {
		await prepareAttachmentConversation(page, {
			artifactName: "test-document.txt",
			contentText: MOCK_ATTACHMENT_CONTENT,
			buffer: Buffer.from("Test file content"),
			message: "Message with attachment",
		});

		const workspace = await openAttachmentWorkspace(page);
		await expect(workspace).toBeVisible({ timeout: 5000 });
		await expect(workspace).toContainText("test-document.txt");
		await expect(workspace).toContainText(MOCK_ATTACHMENT_CONTENT, {
			timeout: 10000,
		});
	});

	test("workspace shows the document header when contentText is empty", async ({
		page,
	}) => {
		await prepareAttachmentConversation(page, {
			artifactName: "empty-document.txt",
			contentText: "",
			buffer: Buffer.from(""),
			message: "Message with empty attachment",
		});

		const workspace = await openAttachmentWorkspace(page);
		await expect(workspace).toBeVisible({ timeout: 5000 });
		await expect(workspace).toContainText("empty-document.txt");
	});

	test("workspace surfaces an error when the preview fails", async ({
		page,
	}) => {
		await prepareAttachmentConversation(page, {
			artifactName: "missing-document.txt",
			contentText: null,
			status: 404,
			buffer: Buffer.from("Test content"),
			message: "Message with missing attachment",
		});

		const workspace = await openAttachmentWorkspace(page);
		await expect(workspace).toBeVisible({ timeout: 5000 });
		await expect(workspace).toContainText(
			/failed|error|not\s*found|not.*available/i,
			{ timeout: 10000 },
		);
	});

	test("workspace closes via the close control", async ({ page }) => {
		await prepareAttachmentConversation(page, {
			artifactName: "test-document.txt",
			contentText: MOCK_ATTACHMENT_CONTENT,
			buffer: Buffer.from("Test content"),
			message: "Test message",
		});

		const workspace = await openAttachmentWorkspace(page);
		await expect(workspace).toBeVisible({ timeout: 5000 });

		await closeAttachmentWorkspace(page);

		await expect(workspace).not.toBeVisible({ timeout: 5000 });
	});

	test("XSS content is rendered as inert text, not executed", async ({
		page,
	}) => {
		let dialogOpened = false;
		page.on("dialog", (dialog) => {
			dialogOpened = true;
			void dialog.dismiss();
		});

		await prepareAttachmentConversation(page, {
			artifactName: "xss-test.txt",
			contentText: MOCK_XSS_CONTENT,
			buffer: Buffer.from("XSS test content"),
			message: "XSS test message",
		});

		const workspace = await openAttachmentWorkspace(page);
		await expect(workspace).toBeVisible({ timeout: 5000 });
		// The visible "Plain text" tail proves the payload rendered as text.
		await expect(workspace).toContainText("Plain text", { timeout: 10000 });
		// No injected <script>/onerror executed.
		expect(dialogOpened).toBe(false);
		await expect(workspace.locator("script")).toHaveCount(0);
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
