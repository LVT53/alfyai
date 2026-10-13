import { crc32, deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import { buildTrustedHtmlPreviewSrcdoc } from "../../src/lib/components/document-workspace/preview-runtime/text";
import { renderStandardReportHtml } from "../../src/lib/server/services/file-production/renderers/standard-report-html";
import { validateGeneratedDocumentSource } from "../../src/lib/server/services/file-production/source-schema";
import { buildFileServingResponseHeaders } from "../../src/lib/server/services/file-serving-response-policy";

// A generated HTML report is the one script-capable page the app previews, and
// its policy used to allow `img-src https: http:` (RV-X M-3): under report-only,
// the production default, the renderer's escaping was the only thing between a
// model-written picture address and a request nobody clicked. The policy is now
// `img-src data:`, like every other preview's, and the report carries its
// pictures as bytes (`file-production/report-images.ts`).
//
// This holds the browser to it, on both paths a report is previewed by: the
// header `/api/chat/files/[id]/preview` serves it with, and the meta tag the
// in-app preview adds to the srcdoc. The report is the renderer's own output
// with a picture inlined, plus a canary: a remote <img> written into it AFTER
// rendering, as a renderer bug or a hostile edit would. The canary must never
// be requested; the inlined picture must show; the report's own script must run.

const SENTINEL_HOST = "sentinel.invalid";
const CANARY = `https://${SENTINEL_HOST}/remote-picture.png`;
/** A valid 1x1 PNG, built here so its checksums are right whatever else changes. */
function onePixelPng(): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0); // width
	header.writeUInt32BE(1, 4); // height
	header[8] = 8; // bit depth
	header[9] = 2; // RGB
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.from([0, 0x2f, 0x6b, 0xa8]))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
const PNG_DATA_URI = `data:image/png;base64,${onePixelPng().toString("base64")}`;
const PICTURE_URL = "https://example.com/inlined.png";

function reportHtml(): string {
	const validation = validateGeneratedDocumentSource({
		version: 1,
		template: "alfyai_standard_report",
		title: "Picture report",
		blocks: [
			{ type: "heading", level: 2, text: "Findings" },
			{
				type: "paragraph",
				text: "The picture below was fetched when the report was made.",
			},
			{
				type: "image",
				source: { kind: "https", url: PICTURE_URL },
				altText: "Inlined picture",
			},
		],
	});
	if (!validation.ok) throw new Error(validation.message);
	const rendered = renderStandardReportHtml(
		validation.source,
		undefined,
		new Map([[PICTURE_URL, PNG_DATA_URI]]),
	).content.toString("utf8");
	// What a renderer bug or a hostile edit would add.
	return rendered.replace(
		"</body>",
		`<img id="canary" src="${CANARY}" alt="canary"></body>`,
	);
}

/**
 * What happens to a request to the stand-in host: `reached` is what got past
 * the browser to the network (the route sees it); `refused` is what the
 * browser's own policy stopped, as the console says it (a violation of
 * `img-src data:`). A policy that works shows up as the second, never the first.
 */
async function watchSentinel(page: Page) {
	const reached: string[] = [];
	const refused: string[] = [];
	await page
		.context()
		.route(
			new RegExp(`^https?://${SENTINEL_HOST.replace(/\./g, "\\.")}/`),
			async (route) => {
				reached.push(route.request().url());
				await route.fulfill({
					status: 200,
					contentType: "image/png",
					body: "",
				});
			},
		);
	page.on("console", (message) => {
		const text = message.text();
		if (text.includes(CANARY) && text.includes('directive: "img-src data:"')) {
			refused.push(CANARY);
		}
	});
	return { reached, refused };
}

test.describe("a generated HTML report is previewed with pictures from itself only", () => {
	test("the header the preview route serves it with", async ({ page }) => {
		const sentinel = await watchSentinel(page);
		const body = reportHtml();
		const headers = buildFileServingResponseHeaders({
			mode: "preview",
			contentLength: Buffer.byteLength(body),
			contentType: "text/html",
			filename: "report.html",
			previewProfile: "standard-report",
		});
		await page.route("**/report-preview-fixture", (route) =>
			route.fulfill({ status: 200, headers, body }),
		);

		await page.goto("/report-preview-fixture");

		await expect(
			page.getByRole("heading", { level: 1, name: "Picture report" }),
		).toBeVisible();
		// The report's pictures load lazily: bring this one into view.
		await page
			.getByRole("img", { name: "Inlined picture" })
			.scrollIntoViewIfNeeded();
		await expect(
			page.getByRole("img", { name: "Inlined picture" }),
		).toHaveJSProperty("naturalWidth", 1);
		await expect(page.locator("#canary")).toHaveJSProperty("naturalWidth", 0);
		await page.waitForTimeout(1_000);
		expect(sentinel.reached, "requests that reached the stand-in host").toEqual(
			[],
		);
		expect(sentinel.refused, "requests the policy refused").toEqual([CANARY]);
	});

	test("the meta tag the in-app preview adds to the srcdoc", async ({
		page,
	}) => {
		const sentinel = await watchSentinel(page);
		const srcdoc = buildTrustedHtmlPreviewSrcdoc(reportHtml());
		await page.route("**/report-preview-host", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/html",
				body: `<!doctype html><title>host</title><iframe title="report" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcdoc="${srcdoc
					.replace(/&/g, "&amp;")
					.replace(/"/g, "&quot;")}"></iframe>`,
			}),
		);

		await page.goto("/report-preview-host");

		const report = page.frameLocator("iframe[title=report]");
		await expect(
			report.getByRole("heading", { level: 1, name: "Picture report" }),
		).toBeVisible();
		await report
			.getByRole("img", { name: "Inlined picture" })
			.scrollIntoViewIfNeeded();
		await expect(
			report.getByRole("img", { name: "Inlined picture" }),
		).toHaveJSProperty("naturalWidth", 1);
		await expect(report.locator("#canary")).toHaveJSProperty("naturalWidth", 0);
		await page.waitForTimeout(1_000);
		expect(sentinel.reached, "requests that reached the stand-in host").toEqual(
			[],
		);
		expect(sentinel.refused, "requests the policy refused").toEqual([CANARY]);
	});

	// What makes the cases above mean something: the canary IS requested when the
	// policy allows it, so a silent stand-in host is the policy's doing.
	test("control: the old policy let the same page fetch the picture", async ({
		page,
	}) => {
		const sentinel = await watchSentinel(page);
		const body = reportHtml();
		const old =
			"default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
		await page.route("**/report-preview-old", (route) =>
			route.fulfill({
				status: 200,
				headers: {
					"content-type": "text/html",
					"content-security-policy": old,
				},
				body,
			}),
		);

		await page.goto("/report-preview-old");

		await expect.poll(() => sentinel.reached.length).toBeGreaterThan(0);
	});
});
