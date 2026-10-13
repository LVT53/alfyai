// Putting a file in the composer without a parser behind it: what the specs of
// the composer's small popups need (the outline list beside an attachment, the
// context ring that appears once something is attached).
//
// The upload endpoints answer the way the server does for a parsed PDF, so the
// composer shows its pill, the outline icon (when the answer carries an
// outline) and the context ring. A real parse needs the extraction worker; what
// is under test in those specs is the popup, not the parser. The file input is
// set programmatically, which is the only part of picking a file a test cannot
// do with a real click.
import { expect, type Page } from "@playwright/test";
import { waitForMotionToSettle } from "./helpers";

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

export type OutlineSection = {
	level: number;
	title: string;
	offset: number;
	preview: string;
};

const LEASE = {
	id: "artifact-lease-outline",
	name: "Lease agreement 2026.pdf",
	mimeType: "application/pdf",
	sizeBytes: 482_112,
	tokenEstimate: 18_400,
	pageCount: 24,
	pageCountKind: "physical",
};

/**
 * The upload endpoints answer the way the server does for a parsed PDF; with an
 * `outline` the artifact carries its headings.
 */
async function mockLeaseUpload(page: Page, outline: OutlineSection[] = []) {
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
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				artifact: {
					...LEASE,
					type: "source_document",
					retrievalClass: "durable",
					conversationId: null,
					summary: LEASE.name,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					...(outline.length > 0 ? { outline } : {}),
				},
				promptReady: true,
				promptArtifactId: `prompt-${LEASE.id}`,
				readinessError: null,
			}),
		});
	});
	await page.route("**/api/knowledge/*/preview", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "image/png" },
			body: PNG_1X1,
		});
	});
}

/**
 * Attaches the lease the way the file input does and waits for its pill. The
 * composer is rendered on the server with its input disabled until it hydrates;
 * `setInputFiles` does not wait, and a disabled input never fires.
 */
export async function attachLease(
	page: Page,
	outline: OutlineSection[] = [],
): Promise<void> {
	await mockLeaseUpload(page, outline);
	const fileInput = page.locator('input[type="file"]').first();
	await expect(fileInput).toBeEnabled({ timeout: 20000 });
	await fileInput.setInputFiles({
		name: LEASE.name,
		mimeType: LEASE.mimeType,
		buffer: Buffer.from("%PDF-1.4"),
	});
	await expect(page.getByTestId("composer-chip-attachment")).toBeVisible({
		timeout: 20000,
	});
	await waitForMotionToSettle(page);
}
