// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/generated-file-serving", () => ({
	readStandardReportHtml: vi.fn(),
}));
vi.mock(
	"$lib/server/services/knowledge/store/working-document-file-serving",
	() => ({ resolveWorkingDocumentFileServing: vi.fn() }),
);

const { readStandardReportHtml } = await import(
	"$lib/server/services/generated-file-serving"
);
const { resolveWorkingDocumentFileServing } = await import(
	"$lib/server/services/knowledge/store/working-document-file-serving"
);
const { readReportHtml } = await import("./report-html");

const readChatFile = vi.mocked(readStandardReportHtml);
const serveLibrary = vi.mocked(resolveWorkingDocumentFileServing);
const REPORT = "<!doctype html><h1>Weekend report</h1>";

const served = (extra: Record<string, unknown> = {}) =>
	({
		ok: true,
		status: 200,
		body: new Uint8Array(Buffer.from(REPORT)),
		headers: { "Content-Type": "text/html; charset=utf-8" },
		previewProfile: "standard-report",
		...extra,
	}) as unknown as Awaited<ReturnType<typeof serveLibrary>>;

beforeEach(() => {
	vi.clearAllMocks();
});

// The report as the panel's preview served it: a chat file's by the chat-file
// preview's rules, a library item's by the library preview's.
describe("readReportHtml", () => {
	it("reads a chat file's report through the chat-file preview's own read", async () => {
		readChatFile.mockResolvedValue(REPORT);
		await expect(
			readReportHtml({ userId: "user-1", report: { fileId: "file-9" } }),
		).resolves.toBe(REPORT);
		expect(readChatFile).toHaveBeenCalledWith({
			userId: "user-1",
			fileId: "file-9",
		});
		expect(serveLibrary).not.toHaveBeenCalled();
	});

	it("reads a library item's report through the library preview's own read, as written", async () => {
		serveLibrary.mockResolvedValue(served());
		await expect(
			readReportHtml({ userId: "user-1", report: { artifactId: "lib-1" } }),
		).resolves.toBe(REPORT);
		// No origin: the report as written, without the bridge the preview adds.
		expect(serveLibrary).toHaveBeenCalledWith({
			userId: "user-1",
			artifactId: "lib-1",
			mode: "preview",
		});
		expect(readChatFile).not.toHaveBeenCalled();
	});

	it("is null for a library item the preview would not serve as a standard report", async () => {
		for (const answer of [
			{ ok: false, status: 404, error: "Artifact not found" },
			served({ previewProfile: undefined }),
			served({ status: 206 }),
		]) {
			serveLibrary.mockResolvedValue(
				answer as Awaited<ReturnType<typeof serveLibrary>>,
			);
			await expect(
				readReportHtml({ userId: "user-2", report: { artifactId: "lib-1" } }),
				JSON.stringify(answer),
			).resolves.toBeNull();
		}
	});
});
