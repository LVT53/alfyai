import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	NextcloudFilesError,
	nextcloudReadFile,
	nextcloudSearch,
} from "$lib/server/services/connections/providers/nextcloud-files";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import { getConnectionSecret } from "$lib/server/services/connections/store";

import { runFilesTool, sanitizeFilesToolInput } from "./files";

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveConnectionsForCapability: vi.fn(),
	needsDisambiguation: vi.fn(),
}));
vi.mock("$lib/server/services/connections/store", () => ({
	getConnectionSecret: vi.fn(),
}));
vi.mock(
	"$lib/server/services/connections/providers/nextcloud-files",
	async () => {
		const actual = await vi.importActual<
			typeof import("$lib/server/services/connections/providers/nextcloud-files")
		>("$lib/server/services/connections/providers/nextcloud-files");
		return {
			...actual,
			nextcloudSearch: vi.fn(),
			nextcloudReadFile: vi.fn(),
		};
	},
);

const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const needsDisambiguationMock = vi.mocked(needsDisambiguation);
const getConnectionSecretMock = vi.mocked(getConnectionSecret);
const nextcloudSearchMock = vi.mocked(nextcloudSearch);
const nextcloudReadFileMock = vi.mocked(nextcloudReadFile);

function makeConn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "nextcloud",
		label: "Nextcloud",
		accountIdentifier: "alice",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["files"],
		config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

describe("sanitizeFilesToolInput", () => {
	it("trims optional query and path and drops empty strings", () => {
		expect(
			sanitizeFilesToolInput({ action: "search", query: "  invoice  " }),
		).toEqual({ action: "search", query: "invoice" });
		expect(sanitizeFilesToolInput({ action: "read", path: "" })).toEqual({
			action: "read",
		});
	});
});

describe("runFilesTool", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		nextcloudSearchMock.mockReset();
		nextcloudReadFileMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
	});

	it("returns a graceful note without throwing when there is no Files connection", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const outcome = await runFilesTool("user-1", {
			action: "search",
			query: "x",
		});

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"don't have a Files connection",
		);
		expect(outcome.modelPayload.results).toEqual([]);
		expect(outcome.modelPayload.citations).toEqual([]);
		expect(getConnectionSecretMock).not.toHaveBeenCalled();
	});

	it("surfaces ambiguity but still executes against the first (sorted) connection", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice Nextcloud" });
		const connB = makeConn({ id: "conn-b", label: "Bob Nextcloud" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudSearchMock.mockResolvedValue([]);

		const outcome = await runFilesTool("user-1", {
			action: "search",
			query: "report",
		});

		expect(nextcloudSearchMock).toHaveBeenCalledWith(connA, "secret", "report");
		expect(outcome.modelPayload.message).toContain("2 Files connections");
		expect(outcome.modelPayload.message).toContain("Alice Nextcloud");
		expect(outcome.modelPayload.message).toContain("Bob Nextcloud");
	});

	it("search returns compact results and citations", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudSearchMock.mockResolvedValue([
			{
				name: "report.pdf",
				path: "Documents/report.pdf",
				isDir: false,
				size: 4096,
				mtime: null,
				contentType: "application/pdf",
				etag: "etag-1",
			},
			{
				name: "Documents",
				path: "Documents",
				isDir: true,
				size: 0,
				mtime: null,
				contentType: null,
				etag: "etag-2",
			},
		]);

		const outcome = await runFilesTool("user-1", {
			action: "search",
			query: "report",
		});

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toEqual([
			{
				name: "report.pdf",
				path: "Documents/report.pdf",
				isDir: false,
				size: 4096,
				contentType: "application/pdf",
			},
			{
				name: "Documents",
				path: "Documents",
				isDir: true,
				size: 0,
				contentType: null,
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{
				label: "report.pdf",
				path: "Documents/report.pdf",
				url: expect.stringContaining("cloud.example.com"),
			},
		]);
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				id: "files:Documents/report.pdf",
				title: "report.pdf",
				sourceType: "document",
			}),
		]);
	});

	it("read returns inline text content for text-like files", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudReadFileMock.mockResolvedValue({
			bytes: new TextEncoder().encode("hello world"),
			etag: "etag-1",
			contentType: "text/plain",
		});

		const outcome = await runFilesTool("user-1", {
			action: "read",
			path: "notes/todo.txt",
		});

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toEqual([
			{
				name: "todo.txt",
				path: "notes/todo.txt",
				isDir: false,
				size: 11,
				contentType: "text/plain",
				content: "hello world",
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{
				label: "todo.txt",
				path: "notes/todo.txt",
				url: expect.stringContaining("cloud.example.com"),
			},
		]);
	});

	it("read notes binary files instead of inlining raw bytes", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudReadFileMock.mockResolvedValue({
			bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			etag: "etag-1",
			contentType: "image/png",
		});

		const outcome = await runFilesTool("user-1", {
			action: "read",
			path: "photos/logo.png",
		});

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results[0]).toMatchObject({
			binary: true,
			contentType: "image/png",
		});
		expect(outcome.modelPayload.results[0]?.content).toBeUndefined();
		expect(outcome.modelPayload.message).toContain("binary file");
	});

	it("maps needs_reauth adapter errors to a graceful note without leaking the secret", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("super-secret-password");
		nextcloudSearchMock.mockRejectedValue(
			new NextcloudFilesError(
				"Nextcloud rejected the stored app password",
				"needs_reauth",
			),
		);

		const outcome = await runFilesTool("user-1", {
			action: "search",
			query: "report",
		});

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnected");
		expect(outcome.modelPayload.message).not.toContain("super-secret-password");
	});

	it("maps generic adapter failures to a graceful note", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudReadFileMock.mockRejectedValue(new Error("network exploded"));

		const outcome = await runFilesTool("user-1", {
			action: "read",
			path: "notes/todo.txt",
		});

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("couldn't reach your files");
	});

	it("returns a graceful note when the connection secret is missing", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue(null);

		const outcome = await runFilesTool("user-1", {
			action: "search",
			query: "report",
		});

		expect(outcome.modelPayload.success).toBe(false);
		expect(nextcloudSearchMock).not.toHaveBeenCalled();
	});

	it("requires a query for search and a path for read", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");

		const searchOutcome = await runFilesTool("user-1", { action: "search" });
		expect(searchOutcome.modelPayload.success).toBe(false);
		expect(searchOutcome.modelPayload.message).toContain(
			"search query is required",
		);

		const readOutcome = await runFilesTool("user-1", { action: "read" });
		expect(readOutcome.modelPayload.success).toBe(false);
		expect(readOutcome.modelPayload.message).toContain("path is required");
	});
});
