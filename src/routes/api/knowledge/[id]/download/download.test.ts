import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAuth = vi.fn();
const mockGetArtifactForUser = vi.fn();
const mockGetSourceArtifactId = vi.fn();
const mockGetChatFileByUser = vi.fn();
const mockReadChatFileContentByUser = vi.fn();

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock("$lib/server/services/knowledge/store/core", () => ({
	getArtifactForUser: (...args: unknown[]) => mockGetArtifactForUser(...args),
	getSourceArtifactIdForNormalizedArtifact: (...args: unknown[]) =>
		mockGetSourceArtifactId(...args),
}));

vi.mock("$lib/server/services/chat-files", () => ({
	getChatFileByUser: (...args: unknown[]) => mockGetChatFileByUser(...args),
	readChatFileContentByUser: (...args: unknown[]) =>
		mockReadChatFileContentByUser(...args),
}));

import { GET } from "./+server";

type DownloadRouteEvent = Parameters<typeof GET>[0];

describe("GET /api/knowledge/[id]/download", () => {
	const mockUser = { id: "download-user-123", email: "test@example.com" };

	async function writeDownloadFile(
		storagePath: string,
		contents: Buffer | string,
	) {
		const absolutePath = join(process.cwd(), storagePath);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, contents);
	}

	function makeDownloadEvent(
		artifactId: string,
		headers?: HeadersInit,
	): DownloadRouteEvent {
		return {
			request: new Request(
				`http://localhost/api/knowledge/${artifactId}/download`,
				{
					headers,
				},
			),
			locals: { user: mockUser },
			params: { id: artifactId },
		} as unknown as DownloadRouteEvent;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockImplementation(() => {});
		mockGetSourceArtifactId.mockResolvedValue(null);
		mockGetChatFileByUser.mockResolvedValue(null);
		mockReadChatFileContentByUser.mockResolvedValue(null);
	});

	afterEach(async () => {
		await rm(join(process.cwd(), "data", "knowledge", mockUser.id), {
			recursive: true,
			force: true,
		});
	});

	it("returns text artifact downloads with attachment and no-store headers", async () => {
		mockGetArtifactForUser.mockResolvedValue({
			id: "skill-note-123",
			name: "Skill Note",
			storagePath: null,
			contentText: "Private note content",
			mimeType: "text/plain",
			extension: "md",
			type: "skill_note",
			metadata: null,
		});

		const response = await GET(makeDownloadEvent("skill-note-123"));

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"text/markdown; charset=utf-8",
		);
		expect(response.headers.get("Content-Disposition")).toBe(
			`attachment; filename="Skill Note.md"; filename*=UTF-8''Skill%20Note.md`,
		);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("Content-Security-Policy")).toBeNull();
		expect(await response.text()).toBe("Private note content");
	});

	it("propagates suffix range responses for stored downloads", async () => {
		await writeDownloadFile(
			"data/knowledge/download-user-123/ranged.pdf",
			Buffer.from("0123456789"),
		);
		mockGetArtifactForUser.mockResolvedValue({
			id: "source-ranged",
			name: "ranged.pdf",
			storagePath: "data/knowledge/download-user-123/ranged.pdf",
			contentText: null,
			mimeType: "application/pdf",
			extension: "pdf",
			type: "source_document",
			metadata: null,
		});

		const response = await GET(
			makeDownloadEvent("source-ranged", { Range: "bytes=-4" }),
		);

		expect(response.status).toBe(206);
		expect(response.headers.get("Content-Range")).toBe("bytes 6-9/10");
		expect(response.headers.get("Content-Length")).toBe("4");
		expect(response.headers.get("Content-Disposition")).toBe(
			`attachment; filename="ranged.pdf"; filename*=UTF-8''ranged.pdf`,
		);
		expect(await response.text()).toBe("6789");
	});

	it("rejects invalid generated_output XLSX source chat files before download", async () => {
		mockGetArtifactForUser.mockResolvedValue({
			id: "generated-123",
			name: "generated_report.xlsx",
			storagePath: null,
			contentText: "Some generated text summary",
			mimeType: "text/plain",
			extension: "xlsx",
			type: "generated_output",
			metadata: { sourceChatFileId: "chatfile-456" },
		});
		mockGetChatFileByUser.mockResolvedValue({
			id: "chatfile-456",
			filename: "report.xlsx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});
		mockReadChatFileContentByUser.mockResolvedValue(
			Buffer.from("not an ooxml zip"),
		);

		const response = await GET(makeDownloadEvent("generated-123"));

		expect(response.status).toBe(415);
		const body = await response.json();
		expect(body.error).toBe("Invalid generated file content");
	});
});
