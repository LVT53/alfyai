import { describe, expect, it } from "vitest";
import {
	applyFileServingRange,
	buildFileServingResponseHeaders,
} from "./file-serving-response-policy";

describe("file-serving response policy", () => {
	function baseHeaders(contentLength: number) {
		return buildFileServingResponseHeaders({
			mode: "preview",
			contentLength,
			contentType: "text/plain",
			filename: "notes.txt",
		});
	}

	it("returns partial response bytes in a detached backing buffer", () => {
		const source = Buffer.from("hello world");
		const result = applyFileServingRange({
			body: source,
			rangeHeader: "bytes=6-10",
			headers: baseHeaders(source.length),
		});

		expect(result.status).toBe(206);
		expect(Buffer.from(result.body).toString()).toBe("world");
		expect(result.body.byteLength).toBe(5);
		expect(result.body.buffer).not.toBe(source.buffer);
		expect(result.headers["Content-Length"]).toBe("5");
		expect(result.headers["Content-Range"]).toBe("bytes 6-10/11");
	});

	it("serves open-ended and suffix byte ranges", () => {
		const source = Buffer.from("hello world");

		const openEnded = applyFileServingRange({
			body: source,
			rangeHeader: "bytes=6-",
			headers: baseHeaders(source.length),
		});
		const suffix = applyFileServingRange({
			body: source,
			rangeHeader: "bytes=-5",
			headers: baseHeaders(source.length),
		});

		expect(openEnded.status).toBe(206);
		expect(Buffer.from(openEnded.body).toString()).toBe("world");
		expect(openEnded.headers["Content-Range"]).toBe("bytes 6-10/11");
		expect(suffix.status).toBe(206);
		expect(Buffer.from(suffix.body).toString()).toBe("world");
		expect(suffix.headers["Content-Range"]).toBe("bytes 6-10/11");
	});

	it("returns 416 for unsatisfiable ranges including empty files", () => {
		const beyondEnd = applyFileServingRange({
			body: Buffer.from("hello"),
			rangeHeader: "bytes=99-120",
			headers: baseHeaders(5),
		});
		const emptyFile = applyFileServingRange({
			body: new Uint8Array(0),
			rangeHeader: "bytes=0-0",
			headers: baseHeaders(0),
		});

		expect(beyondEnd.status).toBe(416);
		expect(beyondEnd.body.byteLength).toBe(0);
		expect(beyondEnd.headers["Content-Length"]).toBe("0");
		expect(beyondEnd.headers["Content-Range"]).toBe("bytes */5");
		expect(emptyFile.status).toBe(416);
		expect(emptyFile.headers["Content-Range"]).toBe("bytes */0");
	});

	it("ignores malformed, huge, and unsupported multipart ranges", () => {
		const source = Buffer.from("hello");
		for (const rangeHeader of [
			"bytes=abc",
			"bytes=4-2",
			"bytes=999999999999999999999-",
			"bytes=0-1,3-4",
		]) {
			const result = applyFileServingRange({
				body: source,
				rangeHeader,
				headers: baseHeaders(source.length),
			});

			expect(result.status).toBe(200);
			expect(Buffer.from(result.body).toString()).toBe("hello");
			expect(result.headers["Content-Range"]).toBeUndefined();
		}
	});
});

// ADR-0068. A generated HTML report is script-capable (its own inline script
// draws the section menu and the source tooltips), so its preview policy is the
// widest one the app serves. What it may LOAD is not wider than any other
// preview's: pictures are inlined into the report when it is rendered, so a
// remote address is never something it needs to fetch.
describe("the CSP of a script-capable report preview", () => {
	function directive(csp: string, name: string): string | undefined {
		return csp
			.split(";")
			.map((part) => part.trim())
			.find((part) => part === name || part.startsWith(`${name} `));
	}

	function csp(previewProfile?: "standard-report", contentType = "text/html") {
		return buildFileServingResponseHeaders({
			mode: "preview",
			contentLength: 10,
			contentType,
			filename: contentType === "text/html" ? "report.html" : "drawing.svg",
			previewProfile,
		})["Content-Security-Policy"];
	}

	it("lets a report load pictures from itself only: img-src is data:, the same as every other preview", () => {
		const report = csp("standard-report");
		const plainHtml = csp(undefined);
		const svg = csp(undefined, "image/svg+xml");

		expect(directive(report, "img-src")).toBe("img-src data:");
		expect(directive(plainHtml, "img-src")).toBe("img-src data:");
		expect(directive(svg, "img-src")).toBe("img-src data:");
	});

	it("names no remote scheme anywhere in it", () => {
		const report = csp("standard-report");
		expect(report).not.toMatch(/\bhttps?:/);
		expect(report).not.toContain("*");
	});

	it("keeps what a report does need: its own inline script and style, and nothing it can fetch or frame", () => {
		const report = csp("standard-report");
		expect(directive(report, "default-src")).toBe("default-src 'none'");
		expect(directive(report, "script-src")).toBe("script-src 'unsafe-inline'");
		expect(directive(report, "style-src")).toBe("style-src 'unsafe-inline'");
		expect(directive(report, "object-src")).toBe("object-src 'none'");
		expect(directive(report, "form-action")).toBe("form-action 'none'");
		expect(directive(report, "base-uri")).toBe("base-uri 'none'");
		expect(directive(report, "connect-src")).toBeUndefined();
	});
});

describe("download Content-Disposition", () => {
	const DOCX =
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	function download(filename: string, contentType: string) {
		return buildFileServingResponseHeaders({
			mode: "download",
			contentLength: 1,
			contentType,
			filename,
		})["Content-Disposition"] as string;
	}

	it("carries an ASCII fallback and the RFC 5987 real name for an accented title", () => {
		expect(download("Bécsi útiterv.docx", DOCX)).toBe(
			`attachment; filename="Becsi utiterv.docx"; filename*=UTF-8''B%C3%A9csi%20%C3%BAtiterv.docx`,
		);
	});

	it("never lets quotes, slashes or RFC 5987 delimiters break out of the header", () => {
		const value = download(`Tom's "plan" (a/b)*.docx`, DOCX);
		expect(value).toBe(
			`attachment; filename="Tom's _plan_ (a_b)_.docx"; filename*=UTF-8''Tom%27s%20%22plan%22%20%28a%2Fb%29%2A.docx`,
		);
	});

	it("adds the extension its type needs when the name has none", () => {
		expect(download("Terv", DOCX)).toContain(`filename="Terv.docx"`);
		expect(download("Report v1.2", DOCX)).toContain(
			`filename="Report v1.2.docx"`,
		);
		expect(download("notes", "text/markdown; charset=utf-8")).toContain(
			`filename="notes.md"`,
		);
	});

	it("does not double an extension it already has", () => {
		expect(download("Plan.docx", DOCX)).toContain(`filename="Plan.docx"`);
		expect(download("Plan.docx", DOCX)).not.toContain(".docx.docx");
		expect(download("README.markdown", "text/markdown")).toContain(
			`filename="README.markdown"`,
		);
	});

	it("keeps an inline preview name readable instead of percent-encoding it in quotes", () => {
		const value = buildFileServingResponseHeaders({
			mode: "preview",
			contentLength: 1,
			contentType: "text/plain",
			filename: "Jegyzet é.txt",
		})["Content-Disposition"];
		expect(value).toBe(
			`inline; filename="Jegyzet e.txt"; filename*=UTF-8''Jegyzet%20%C3%A9.txt`,
		);
	});
});
