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
	user: { id: string; email: string } | null = {
		id: "user-1",
		email: "test@example.com",
	},
	headers?: HeadersInit,
) {
	return {
		request: new Request(`http://localhost/api/chat/files/${fileId}/preview`, {
			headers,
		}),
		locals: { user },
		params: { id: fileId },
		url: new URL(`http://localhost/api/chat/files/${fileId}/preview`),
		route: { id: "/api/chat/files/[id]/preview" },
	} as Parameters<typeof GET>[0];
}

function serviceSuccess(
	body = "hello world",
	headers: Record<string, string> = {
		"Content-Type": "text/plain",
		"Content-Length": "11",
		"Content-Disposition": 'inline; filename="notes.txt"',
		"Cache-Control": "private, max-age=3600",
	},
) {
	return {
		ok: true as const,
		status: 200 as const,
		body: Buffer.from(body),
		headers,
	};
}

describe("GET /api/chat/files/[id]/preview", () => {
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

	it("returns 401 when auth passes but the local user is missing", async () => {
		const response = await GET(makeEvent("file-1", null));
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
			mode: "preview",
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
			mode: "preview",
		});
	});

	it("returns inline preview bytes and headers from the service", async () => {
		mockResolveGeneratedFileServing.mockResolvedValue(serviceSuccess());

		const response = await GET(makeEvent());

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/plain");
		expect(response.headers.get("Content-Length")).toBe("11");
		expect(response.headers.get("Content-Disposition")).toContain(
			'inline; filename="notes.txt"',
		);
		expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
		expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
			"hello world",
		);
	});

	it("passes byte range requests through and preserves partial response status", async () => {
		mockResolveGeneratedFileServing.mockResolvedValue({
			...serviceSuccess("world", {
				"Content-Type": "text/plain",
				"Content-Length": "5",
				"Content-Range": "bytes 6-10/11",
				"Accept-Ranges": "bytes",
				"Content-Disposition": 'inline; filename="notes.txt"',
				"Cache-Control": "private, max-age=3600",
			}),
			status: 206,
		});

		const response = await GET(
			makeEvent(
				"file-1",
				{ id: "user-1", email: "test@example.com" },
				{
					Range: "bytes=6-10",
				},
			),
		);

		expect(response.status).toBe(206);
		expect(response.headers.get("Content-Range")).toBe("bytes 6-10/11");
		expect(await response.text()).toBe("world");
		expect(mockResolveGeneratedFileServing).toHaveBeenCalledWith({
			userId: "user-1",
			fileId: "file-1",
			mode: "preview",
			rangeHeader: "bytes=6-10",
		});
	});

	it("returns legacy conversation-owner fallback bytes resolved by the service", async () => {
		mockResolveGeneratedFileServing.mockResolvedValue(serviceSuccess("legacy"));

		const response = await GET(makeEvent("legacy-file"));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("legacy");
		expect(mockResolveGeneratedFileServing).toHaveBeenCalledWith({
			userId: "user-1",
			fileId: "legacy-file",
			mode: "preview",
		});
	});

	it("returns service validation failures as JSON errors", async () => {
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

	it("preserves generated HTML preview security headers from the service", async () => {
		mockResolveGeneratedFileServing.mockResolvedValue(
			serviceSuccess("<!doctype html><h1>Report</h1>", {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Length": "31",
				"Content-Disposition": 'inline; filename="report.html"',
				"Cache-Control": "private, max-age=3600",
				"Content-Security-Policy":
					"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
			}),
		);

		const response = await GET(makeEvent("html-file"));

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"text/html; charset=utf-8",
		);
		expect(response.headers.get("Content-Security-Policy")).toBe(
			"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
		);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});
});
