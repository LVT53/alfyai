import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/generated-file-serving", () => ({
	resolveGeneratedFileServing: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { resolveGeneratedFileServing } from "$lib/server/services/generated-file-serving";
import { GET } from "./+server";

const mockRequireAuth = vi.mocked(requireAuth);
const mockResolveGeneratedFileServing = vi.mocked(resolveGeneratedFileServing);

function makeEvent(
	fileId = "file-1",
	user = { id: "user-1", email: "test@example.com" },
) {
	return {
		request: new Request(`http://localhost/api/chat/files/${fileId}/download`),
		locals: { user },
		params: { id: fileId },
		url: new URL(`http://localhost/api/chat/files/${fileId}/download`),
		route: { id: "/api/chat/files/[id]/download" },
	} as Parameters<typeof GET>[0];
}

function serviceSuccess(
	body = "hello world",
	headers: Record<string, string> = {
		"Content-Type": "application/pdf",
		"Content-Length": "11",
		"Content-Disposition": "attachment; filename*=UTF-8''report.pdf",
		"Cache-Control": "private, no-store",
	},
) {
	return {
		ok: true as const,
		status: 200 as const,
		body: Buffer.from(body),
		headers,
	};
}

describe("GET /api/chat/files/[id]/download", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("returns 401 when unauthenticated", async () => {
		mockRequireAuth.mockImplementation(() => {
			throw new Error("Unauthorized");
		});

		const response = await GET(makeEvent());
		const body = await response.json();

		expect(response.status).toBe(401);
		expect(body.error).toBe("Unauthorized");
		expect(mockResolveGeneratedFileServing).not.toHaveBeenCalled();
	});

	it("returns the service not-found response", async () => {
		mockResolveGeneratedFileServing.mockResolvedValue({
			ok: false,
			status: 404,
			error: "File not found",
		});

		const response = await GET(makeEvent());
		const body = await response.json();

		expect(response.status).toBe(404);
		expect(body.error).toBe("File not found");
		expect(mockResolveGeneratedFileServing).toHaveBeenCalledWith({
			userId: "user-1",
			fileId: "file-1",
			mode: "download",
		});
	});

	it("preserves unassigned generated-file quarantine errors", async () => {
		mockResolveGeneratedFileServing.mockResolvedValue({
			ok: false,
			status: 404,
			error: "File not found",
		});

		const response = await GET(makeEvent("staged-file"));
		const body = await response.json();

		expect(response.status).toBe(404);
		expect(body.error).toBe("File not found");
		expect(mockResolveGeneratedFileServing).toHaveBeenCalledWith({
			userId: "user-1",
			fileId: "staged-file",
			mode: "download",
		});
	});

	it("returns attachment download bytes and headers from the service", async () => {
		mockResolveGeneratedFileServing.mockResolvedValue(serviceSuccess());

		const response = await GET(makeEvent());

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/pdf");
		expect(response.headers.get("Content-Length")).toBe("11");
		expect(response.headers.get("Content-Disposition")).toContain(
			"attachment; filename*=UTF-8''report.pdf",
		);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
			"hello world",
		);
	});

	it("returns legacy conversation-owner fallback bytes resolved by the service", async () => {
		mockResolveGeneratedFileServing.mockResolvedValue(serviceSuccess("legacy"));

		const response = await GET(makeEvent("legacy-file"));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("legacy");
		expect(mockResolveGeneratedFileServing).toHaveBeenCalledWith({
			userId: "user-1",
			fileId: "legacy-file",
			mode: "download",
		});
	});

	it("returns unsupported generated-file errors as JSON", async () => {
		mockResolveGeneratedFileServing.mockResolvedValue({
			ok: false,
			status: 415,
			error: "Unsupported generated file type",
		});

		const response = await GET(makeEvent());
		const body = await response.json();

		expect(response.status).toBe(415);
		expect(body.error).toBe("Unsupported generated file type");
	});

	it("returns invalid generated-file errors as JSON", async () => {
		mockResolveGeneratedFileServing.mockResolvedValue({
			ok: false,
			status: 415,
			error: "Invalid generated file content",
		});

		const response = await GET(makeEvent());
		const body = await response.json();

		expect(response.status).toBe(415);
		expect(body.error).toBe("Invalid generated file content");
	});
});
