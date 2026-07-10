import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	executeNextcloudWrite,
	NextcloudFilesError,
	nextcloudListFolder,
	nextcloudReadFile,
	nextcloudSearch,
	nextcloudStat,
} from "$lib/server/services/connections/providers/nextcloud-files";
import {
	OneDriveError,
	onedriveGetAccessTokenForRead,
	onedriveListFolder,
	onedriveReadFile,
	onedriveSearch,
	onedriveStat,
} from "$lib/server/services/connections/providers/onedrive";
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
vi.mock("$lib/server/services/connections/pending-writes", () => ({
	createPendingWrite: vi.fn(),
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
			nextcloudListFolder: vi.fn(),
			nextcloudReadFile: vi.fn(),
			nextcloudStat: vi.fn(),
			executeNextcloudWrite: vi.fn(),
		};
	},
);
vi.mock("$lib/server/services/connections/providers/onedrive", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/onedrive")
	>("$lib/server/services/connections/providers/onedrive");
	return {
		...actual,
		onedriveSearch: vi.fn(),
		onedriveListFolder: vi.fn(),
		onedriveReadFile: vi.fn(),
		onedriveStat: vi.fn(),
		onedriveGetAccessTokenForRead: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));

const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const needsDisambiguationMock = vi.mocked(needsDisambiguation);
const getConnectionSecretMock = vi.mocked(getConnectionSecret);
const nextcloudSearchMock = vi.mocked(nextcloudSearch);
const nextcloudListFolderMock = vi.mocked(nextcloudListFolder);
const nextcloudReadFileMock = vi.mocked(nextcloudReadFile);
const nextcloudStatMock = vi.mocked(nextcloudStat);
const executeNextcloudWriteMock = vi.mocked(executeNextcloudWrite);
const onedriveSearchMock = vi.mocked(onedriveSearch);
const onedriveListFolderMock = vi.mocked(onedriveListFolder);
const onedriveReadFileMock = vi.mocked(onedriveReadFile);
const onedriveStatMock = vi.mocked(onedriveStat);
const onedriveGetAccessTokenForReadMock = vi.mocked(
	onedriveGetAccessTokenForRead,
);
const createPendingWriteMock = vi.mocked(createPendingWrite);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);

const LOCAL_MODEL_ID = "model1";

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
		hasWriteSecret: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeOneDriveConn(
	overrides: Partial<ConnectionPublic> = {},
): ConnectionPublic {
	return makeConn({
		id: "conn-od-1",
		provider: "onedrive",
		label: "OneDrive",
		accountIdentifier: "alice@example.com",
		config: {},
		oauthScopes: ["Files.Read"],
		...overrides,
	});
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
		nextcloudListFolderMock.mockReset();
		nextcloudReadFileMock.mockReset();
		nextcloudStatMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		distillConnectorPayloadMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		// Default: Option A off — matches today's behavior for tests that don't
		// exercise the distillation gate.
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(false);
	});

	it("returns a graceful note without throwing when there is no Files connection", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const outcome = await runFilesTool(
			"user-1",
			{
				action: "search",
				query: "x",
			},
			LOCAL_MODEL_ID,
		);

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

		const outcome = await runFilesTool(
			"user-1",
			{
				action: "search",
				query: "report",
			},
			LOCAL_MODEL_ID,
		);

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

		const outcome = await runFilesTool(
			"user-1",
			{
				action: "search",
				query: "report",
			},
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toEqual([
			{
				name: "report.pdf",
				path: "Documents/report.pdf",
				isDir: false,
				size: 4096,
				contentType: "application/pdf",
				mtime: null,
			},
			{
				name: "Documents",
				path: "Documents",
				isDir: true,
				size: 0,
				contentType: null,
				mtime: null,
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

	it("list enumerates a folder's children and reports file/folder counts", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudListFolderMock.mockResolvedValue([
			{
				name: "a.pdf",
				path: "Documents/a.pdf",
				isDir: false,
				size: 10,
				mtime: null,
				contentType: "application/pdf",
				etag: "e1",
			},
			{
				name: "b.txt",
				path: "Documents/b.txt",
				isDir: false,
				size: 20,
				mtime: null,
				contentType: "text/plain",
				etag: "e2",
			},
			{
				name: "Sub",
				path: "Documents/Sub",
				isDir: true,
				size: 0,
				mtime: null,
				contentType: null,
				etag: "e3",
			},
		]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "list", path: "Documents" },
			LOCAL_MODEL_ID,
		);

		expect(nextcloudListFolderMock).toHaveBeenCalledWith(
			conn,
			"secret",
			"Documents",
		);
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.message).toBe(
			"Documents contains 3 items (2 files, 1 folder).",
		);
		expect(outcome.modelPayload.results).toHaveLength(3);
		// Only concrete files get citations; the subfolder does not.
		expect(outcome.modelPayload.citations.map((c) => c.label)).toEqual([
			"a.pdf",
			"b.txt",
		]);
	});

	it("list with no path lists the Files root", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudListFolderMock.mockResolvedValue([]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "list" },
			LOCAL_MODEL_ID,
		);

		expect(nextcloudListFolderMock).toHaveBeenCalledWith(conn, "secret", "");
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.message).toBe("your Files root is empty.");
	});

	it("read on a folder path is refused and points at the list action (no fake success)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudStatMock.mockResolvedValue({
			name: "Documents",
			path: "Documents",
			isDir: true,
			size: 0,
			mtime: null,
			contentType: null,
			etag: null,
		});

		const outcome = await runFilesTool(
			"user-1",
			{ action: "read", path: "Documents" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("is a folder, not a file");
		expect(outcome.modelPayload.message).toContain('"list"');
		expect(nextcloudReadFileMock).not.toHaveBeenCalled();
	});

	it("read still reads a regular file when stat says it is not a directory", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudStatMock.mockResolvedValue({
			name: "note.txt",
			path: "note.txt",
			isDir: false,
			size: 5,
			mtime: null,
			contentType: "text/plain",
			etag: null,
		});
		nextcloudReadFileMock.mockResolvedValue({
			bytes: new TextEncoder().encode("hello"),
			etag: null,
			contentType: "text/plain",
			mtime: null,
		});

		const outcome = await runFilesTool(
			"user-1",
			{ action: "read", path: "note.txt" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(nextcloudReadFileMock).toHaveBeenCalledWith(
			conn,
			"secret",
			"note.txt",
		);
	});

	it("read returns inline text content for text-like files", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudReadFileMock.mockResolvedValue({
			bytes: new TextEncoder().encode("hello world"),
			etag: "etag-1",
			contentType: "text/plain",
			mtime: null,
		});

		const outcome = await runFilesTool(
			"user-1",
			{
				action: "read",
				path: "notes/todo.txt",
			},
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toEqual([
			{
				name: "todo.txt",
				path: "notes/todo.txt",
				isDir: false,
				size: 11,
				contentType: "text/plain",
				content: "hello world",
				mtime: null,
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
			mtime: null,
		});

		const outcome = await runFilesTool(
			"user-1",
			{
				action: "read",
				path: "photos/logo.png",
			},
			LOCAL_MODEL_ID,
		);

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

		const outcome = await runFilesTool(
			"user-1",
			{
				action: "search",
				query: "report",
			},
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnected");
		expect(outcome.modelPayload.message).not.toContain("super-secret-password");
	});

	it("maps generic adapter failures to a graceful note", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudReadFileMock.mockRejectedValue(new Error("network exploded"));

		const outcome = await runFilesTool(
			"user-1",
			{
				action: "read",
				path: "notes/todo.txt",
			},
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("couldn't reach your files");
	});

	it("returns a graceful note when the connection secret is missing", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue(null);

		const outcome = await runFilesTool(
			"user-1",
			{
				action: "search",
				query: "report",
			},
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(nextcloudSearchMock).not.toHaveBeenCalled();
	});

	it("requires a query for search and a path for read", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");

		const searchOutcome = await runFilesTool(
			"user-1",
			{ action: "search" },
			LOCAL_MODEL_ID,
		);
		expect(searchOutcome.modelPayload.success).toBe(false);
		expect(searchOutcome.modelPayload.message).toContain(
			"search query is required",
		);

		const readOutcome = await runFilesTool(
			"user-1",
			{ action: "read" },
			LOCAL_MODEL_ID,
		);
		expect(readOutcome.modelPayload.success).toBe(false);
		expect(readOutcome.modelPayload.message).toContain("path is required");
	});
});

// Task 8 — provider dispatch: onedrive -> onedrive* functions, nextcloud ->
// nextcloud* functions. Every test below asserts BOTH that the right
// provider's function was called AND that the other provider's function was
// never touched, so a dispatch bug (calling the wrong provider, or calling
// both) fails loudly.
describe("runFilesTool — provider dispatch (Task 8, onedrive vs nextcloud)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		nextcloudSearchMock.mockReset();
		nextcloudListFolderMock.mockReset();
		nextcloudReadFileMock.mockReset();
		nextcloudStatMock.mockReset();
		onedriveSearchMock.mockReset();
		onedriveListFolderMock.mockReset();
		onedriveReadFileMock.mockReset();
		onedriveStatMock.mockReset();
		onedriveGetAccessTokenForReadMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(false);
		getConnectionSecretMock.mockResolvedValue("secret");
		onedriveGetAccessTokenForReadMock.mockResolvedValue("resolved-token");
	});

	it("search on a onedrive connection calls onedriveSearch, never nextcloudSearch", async () => {
		const conn = makeOneDriveConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		onedriveSearchMock.mockResolvedValue([
			{
				name: "budget.xlsx",
				path: "Documents/budget.xlsx",
				isDir: false,
				size: 1024,
				mtime: "2024-01-03T00:00:00Z",
				contentType: "application/vnd.openxmlformats",
				etag: "etag-1",
				webUrl: "https://onedrive.live.com/budget.xlsx",
			},
		]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "search", query: "budget" },
			LOCAL_MODEL_ID,
		);

		expect(onedriveSearchMock).toHaveBeenCalledWith(conn, "secret", "budget");
		expect(nextcloudSearchMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results[0]?.mtime).toBe("2024-01-03T00:00:00Z");
		// OneDrive's own webUrl is used directly for the citation.
		expect(outcome.modelPayload.citations[0]?.url).toBe(
			"https://onedrive.live.com/budget.xlsx",
		);
	});

	it("search on a nextcloud connection calls nextcloudSearch, never onedriveSearch", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		nextcloudSearchMock.mockResolvedValue([]);

		await runFilesTool(
			"user-1",
			{ action: "search", query: "report" },
			LOCAL_MODEL_ID,
		);

		expect(nextcloudSearchMock).toHaveBeenCalledWith(conn, "secret", "report");
		expect(onedriveSearchMock).not.toHaveBeenCalled();
	});

	it("list on a onedrive connection calls onedriveListFolder, never nextcloudListFolder", async () => {
		const conn = makeOneDriveConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		onedriveListFolderMock.mockResolvedValue([
			{
				name: "a.pdf",
				path: "a.pdf",
				isDir: false,
				size: 10,
				mtime: "2024-01-01T00:00:00Z",
				contentType: "application/pdf",
				etag: "e1",
				webUrl: null,
			},
		]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "list", path: "" },
			LOCAL_MODEL_ID,
		);

		expect(onedriveListFolderMock).toHaveBeenCalledWith(conn, "secret", "");
		expect(nextcloudListFolderMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.results).toHaveLength(1);
	});

	it("read on a onedrive connection stats + reads via onedrive functions, never nextcloud", async () => {
		const conn = makeOneDriveConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		onedriveStatMock.mockResolvedValue({
			name: "todo.txt",
			path: "notes/todo.txt",
			isDir: false,
			size: 5,
			mtime: null,
			contentType: "text/plain",
			etag: null,
			webUrl: null,
		});
		onedriveReadFileMock.mockResolvedValue({
			bytes: new TextEncoder().encode("hello onedrive"),
			etag: "etag-1",
			contentType: "text/plain",
			mtime: "2024-01-02T00:00:00Z",
			webUrl: "https://onedrive.live.com/notes/todo.txt",
		});

		const outcome = await runFilesTool(
			"user-1",
			{ action: "read", path: "notes/todo.txt" },
			LOCAL_MODEL_ID,
		);

		// Task 8 Finding A — the token is resolved exactly ONCE for the whole
		// read (not once per stat + once per download): both onedriveStat (the
		// isDirectory guard) and onedriveReadFile receive the SAME
		// already-resolved token, and onedriveGetAccessTokenForRead itself is
		// only invoked once. See files-onedrive-read-token.test.ts for the
		// equivalent assertion against the real (unmocked) onedrive.ts adapter,
		// counting actual POSTs to Microsoft's token endpoint.
		expect(onedriveGetAccessTokenForReadMock).toHaveBeenCalledTimes(1);
		expect(onedriveStatMock).toHaveBeenCalledWith(
			conn,
			"secret",
			"notes/todo.txt",
			{ accessToken: "resolved-token" },
		);
		expect(onedriveReadFileMock).toHaveBeenCalledWith(
			conn,
			"secret",
			"notes/todo.txt",
			{ accessToken: "resolved-token" },
		);
		expect(nextcloudStatMock).not.toHaveBeenCalled();
		expect(nextcloudReadFileMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results[0]).toMatchObject({
			content: "hello onedrive",
			mtime: "2024-01-02T00:00:00Z",
		});
		expect(outcome.modelPayload.citations[0]?.url).toBe(
			"https://onedrive.live.com/notes/todo.txt",
		);
	});

	it("read on a onedrive folder path is refused via onedriveStat, without calling onedriveReadFile", async () => {
		const conn = makeOneDriveConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		onedriveStatMock.mockResolvedValue({
			name: "Documents",
			path: "Documents",
			isDir: true,
			size: 0,
			mtime: null,
			contentType: null,
			etag: null,
			webUrl: null,
		});

		const outcome = await runFilesTool(
			"user-1",
			{ action: "read", path: "Documents" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("is a folder, not a file");
		expect(onedriveReadFileMock).not.toHaveBeenCalled();
	});

	it("maps a onedrive needs_reauth error to a graceful note mentioning OneDrive, without leaking the secret", async () => {
		const conn = makeOneDriveConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		onedriveSearchMock.mockRejectedValue(
			new OneDriveError(
				"Microsoft rejected the stored access token",
				"needs_reauth",
			),
		);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "search", query: "report" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("OneDrive");
		expect(outcome.modelPayload.message).toContain("reconnected");
		expect(outcome.modelPayload.message).not.toContain("super-secret");
	});

	// Task 8 Finding B — a read-time refresh failing with Microsoft's
	// invalid_grant (the stored refresh token was rejected — expired/revoked)
	// throws OneDriveError code "invalid_grant", not "needs_reauth" (see
	// onedriveRefreshAccessToken's doc comment in onedrive.ts). Before the
	// fix, mapAdapterError had no case for that code and fell through to the
	// generic "couldn't reach your files right now" message — misleading,
	// since retrying can never succeed; only reconnecting can. It must map to
	// the exact same reconnect message as needs_reauth.
	it("maps a onedrive invalid_grant (expired/revoked refresh token) error to the same reconnect message as needs_reauth, not the generic transient-failure message", async () => {
		const conn = makeOneDriveConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		onedriveSearchMock.mockRejectedValue(
			new OneDriveError(
				"Microsoft rejected the stored refresh token",
				"invalid_grant",
			),
		);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "search", query: "report" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toBe(
			"Your OneDrive connection needs to be reconnected before I can access your files. Please reconnect it in Settings.",
		);
	});
});

// Files-B9 write actions (save/move/delete/create_folder/share_link) stay
// Nextcloud-only for v1 — OneDrive is read-only (providers/onedrive.ts's
// module doc). A write against a onedrive connection must be refused
// cleanly, before any Nextcloud-shaped write assumption ever runs.
describe("runFilesTool — write actions against a onedrive connection are refused (Task 8)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		createPendingWriteMock.mockReset();
		executeNextcloudWriteMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
	});

	it.each([
		{ action: "save" as const, extra: { path: "/x.txt", content: "hi" } },
		{
			action: "move" as const,
			extra: { path: "/a.txt", destinationPath: "/b.txt" },
		},
		{ action: "delete" as const, extra: { path: "/a.txt" } },
		{ action: "create_folder" as const, extra: { path: "/NewFolder" } },
		{ action: "share_link" as const, extra: { path: "/a.txt" } },
	])("$action against a onedrive connection: clean not-supported message, no pending write, no secret decrypted", async ({
		action,
		extra,
	}) => {
		const conn = makeOneDriveConn({ allowWrites: true });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action, ...extra },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.action).toBe(action);
		expect(outcome.modelPayload.message).toContain("OneDrive");
		expect(outcome.modelPayload.message.toLowerCase()).toContain("read-only");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
		expect(getConnectionSecretMock).not.toHaveBeenCalled();
	});
});

// Task 8 — the shared Option A local-distill gate (already proven for
// Nextcloud reads above) must cover OneDrive reads identically: raw file
// content must never reach a cloud model un-distilled when local-distill is
// on, regardless of which provider produced it.
describe("runFilesTool — locality Option A distillation gate covers OneDrive (Task 8)", () => {
	const RAW_CONTENT = "SSN 123-45-6789, balance due $9,999.";

	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		onedriveReadFileMock.mockReset();
		onedriveGetAccessTokenForReadMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		distillConnectorPayloadMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);

		const conn = makeOneDriveConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		onedriveGetAccessTokenForReadMock.mockResolvedValue("resolved-token");
		onedriveReadFileMock.mockResolvedValue({
			bytes: new TextEncoder().encode(RAW_CONTENT),
			etag: "etag-1",
			contentType: "text/plain",
			mtime: null,
			webUrl: null,
		});
	});

	async function readOnce() {
		return runFilesTool(
			"user-1",
			{ action: "read", path: "notes/sensitive.txt" },
			"whichever-model",
		);
	}

	it("Option A off: raw OneDrive content is returned unchanged and distill is not called", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await readOnce();

		expect(outcome.modelPayload.results[0]?.content).toBe(RAW_CONTENT);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + cloud model: the model-bound payload carries only the distilled summary — raw OneDrive content is absent", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "The balance due is $9,999.",
		});

		const outcome = await readOnce();

		const serialized = JSON.stringify(outcome.modelPayload);
		expect(serialized).not.toContain(RAW_CONTENT);
		expect(serialized).not.toContain("123-45-6789");
		expect(outcome.modelPayload.results[0]?.content).toBeUndefined();
		expect(outcome.modelPayload.message).toContain(
			"The balance due is $9,999.",
		);
		expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				capability: "files",
				rawText: expect.stringContaining(RAW_CONTENT),
			}),
		);
	});

	it("Option A on + cloud model + distill unavailable: raw OneDrive content is withheld, not leaked", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await readOnce();

		const serialized = JSON.stringify(outcome.modelPayload);
		expect(serialized).not.toContain(RAW_CONTENT);
		expect(serialized).not.toContain("123-45-6789");
		expect(outcome.modelPayload.results[0]?.content).toBeUndefined();
		expect(outcome.modelPayload.message).toContain("withheld");
	});
});

describe("runFilesTool — locality Option A distillation gate", () => {
	const RAW_CONTENT = "SSN 123-45-6789, balance due $9,999.";

	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		nextcloudSearchMock.mockReset();
		nextcloudReadFileMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		distillConnectorPayloadMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);

		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudReadFileMock.mockResolvedValue({
			bytes: new TextEncoder().encode(RAW_CONTENT),
			etag: "etag-1",
			contentType: "text/plain",
			mtime: null,
		});
	});

	async function readOnce() {
		return runFilesTool(
			"user-1",
			{ action: "read", path: "notes/sensitive.txt" },
			"whichever-model",
		);
	}

	it("Option A off: raw content is returned unchanged and distill is not called", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await readOnce();

		expect(outcome.modelPayload.results[0]?.content).toBe(RAW_CONTENT);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + local model: raw content is returned unchanged and distill is not called", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(false);

		const outcome = await readOnce();

		expect(outcome.modelPayload.results[0]?.content).toBe(RAW_CONTENT);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + cloud model: the model-bound payload carries only the distilled summary — raw content is absent", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "The balance due is $9,999.",
		});

		const outcome = await readOnce();

		// The single most important assertion: the raw content string must not
		// appear anywhere in what's returned to the model.
		const serialized = JSON.stringify(outcome.modelPayload);
		expect(serialized).not.toContain(RAW_CONTENT);
		expect(serialized).not.toContain("123-45-6789");
		expect(outcome.modelPayload.results[0]?.content).toBeUndefined();
		expect(outcome.modelPayload.message).toContain(
			"The balance due is $9,999.",
		);
		expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				capability: "files",
				rawText: expect.stringContaining(RAW_CONTENT),
			}),
		);
		// Citations (file name/path — metadata, not sensitive content) are kept.
		expect(outcome.modelPayload.citations).toEqual([
			expect.objectContaining({ path: "notes/sensitive.txt" }),
		]);
	});

	it("Option A on + cloud model + distill unavailable: raw content is withheld, not leaked", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await readOnce();

		const serialized = JSON.stringify(outcome.modelPayload);
		expect(serialized).not.toContain(RAW_CONTENT);
		expect(serialized).not.toContain("123-45-6789");
		expect(outcome.modelPayload.results[0]?.content).toBeUndefined();
		expect(outcome.modelPayload.message).toContain("withheld");
	});
});

describe("runFilesTool — save action (explicit-confirm write flow, 4.3)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		nextcloudStatMock.mockReset();
		executeNextcloudWriteMock.mockReset();
		createPendingWriteMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		getConnectionSecretMock.mockResolvedValue("secret");
		nextcloudStatMock.mockResolvedValue(null);
		createPendingWriteMock.mockResolvedValue({
			id: "pending-1",
			preview: {
				title: "Save note.txt",
				detail: "files.put — /AlfyAI/note.txt",
				reversible: true,
				destructive: false,
				withinAllowlist: true,
				warnings: [],
			},
		});
	});

	it("allowWrites=true: returns a PENDING result (preview + id), creates a pending row, and never calls executeNextcloudWrite", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "save", path: "/AlfyAI/note.txt", content: "hello world" },
			LOCAL_MODEL_ID,
			"conv-1",
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("save");
		expect(outcome.modelPayload.pendingWriteId).toBe("pending-1");
		expect(outcome.modelPayload.preview).toBeDefined();
		expect(outcome.modelPayload.message.toLowerCase()).toContain("confirm");
		expect(outcome.modelPayload.message).not.toMatch(/\bsaved\b(?!.*not)/i);
		expect(outcome.modelPayload.message).toContain("has NOT been saved yet");

		expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
		expect(createPendingWriteMock.mock.calls[0]?.[0]).toBe("user-1");
		const call = createPendingWriteMock.mock.calls[0]?.[1];
		expect(call).toMatchObject({
			connectionId: "conn-1",
			provider: "nextcloud",
			content: "hello world",
			// 7.5 — the caller's conversationId (threaded from ctx.conversationId
			// in normal-chat-tools/index.ts) reaches createPendingWrite so the
			// write-confirm card can be associated with this conversation.
			conversationId: "conv-1",
		});
		expect(call?.op).toMatchObject({
			action: "files.put",
			provider: "nextcloud",
			connectionId: "conn-1",
		});

		// The chokepoint that would actually mutate Nextcloud is never touched
		// by the tool's "save" action — no adapter fetch happens at proposal
		// time.
		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
	});

	it("allowWrites=false: returns a note and creates NO pending row", async () => {
		const conn = makeConn({ allowWrites: false, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "save", path: "/AlfyAI/note.txt", content: "hello world" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("turned off");
		expect(outcome.modelPayload.message).toContain("settings");

		expect(createPendingWriteMock).not.toHaveBeenCalled();
		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
		// allowWrites is checked before the secret is ever decrypted — same
		// hard-gate posture as executeNextcloudWrite (4.2).
		expect(getConnectionSecretMock).not.toHaveBeenCalled();
	});

	it("requires content to save", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "save", path: "/AlfyAI/note.txt" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(createPendingWriteMock).not.toHaveBeenCalled();
	});
});

// GAP A3 — file modification time must be surfaced so "find my most recent /
// newest file" is answerable. NcFile.mtime is parsed by the adapter but was
// previously dropped by the tool result mapping.
describe("runFilesTool — mtime surfacing (GAP A3)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		nextcloudSearchMock.mockReset();
		nextcloudListFolderMock.mockReset();
		nextcloudReadFileMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(false);
		getConnectionSecretMock.mockResolvedValue("secret");
	});

	it("search results carry the file's mtime", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		nextcloudSearchMock.mockResolvedValue([
			{
				name: "budget.xlsx",
				path: "Documents/budget.xlsx",
				isDir: false,
				size: 1024,
				mtime: "Wed, 03 Jan 2024 00:00:00 GMT",
				contentType: "application/vnd.openxmlformats",
				etag: "e1",
			},
		]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "search", query: "budget" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.results[0]?.mtime).toBe(
			"Wed, 03 Jan 2024 00:00:00 GMT",
		);
	});

	it("list results carry each child's mtime", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		nextcloudListFolderMock.mockResolvedValue([
			{
				name: "a.pdf",
				path: "Documents/a.pdf",
				isDir: false,
				size: 10,
				mtime: "Mon, 01 Jan 2024 00:00:00 GMT",
				contentType: "application/pdf",
				etag: "e1",
			},
		]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "list", path: "Documents" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.results[0]?.mtime).toBe(
			"Mon, 01 Jan 2024 00:00:00 GMT",
		);
	});

	it("read result carries the file's mtime", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		nextcloudReadFileMock.mockResolvedValue({
			bytes: new TextEncoder().encode("hello"),
			etag: "etag-1",
			contentType: "text/plain",
			mtime: "Tue, 02 Jan 2024 00:00:00 GMT",
		});

		const outcome = await runFilesTool(
			"user-1",
			{ action: "read", path: "notes/todo.txt" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.results[0]?.mtime).toBe(
			"Tue, 02 Jan 2024 00:00:00 GMT",
		);
	});
});

// GAP A1 — move (also serves rename) and delete write actions. Same
// confirm-gated pending-write pattern as "save": allowWrites is checked
// BEFORE the secret is decrypted, a WriteOperation + preview is built via the
// write-guard, a PENDING row is created, and executeNextcloudWrite is NEVER
// called at proposal time.
describe("runFilesTool — move action (explicit-confirm write flow, GAP A1)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		nextcloudStatMock.mockReset();
		executeNextcloudWriteMock.mockReset();
		createPendingWriteMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		getConnectionSecretMock.mockResolvedValue("secret");
		createPendingWriteMock.mockResolvedValue({
			id: "pending-move-1",
			preview: {
				title: "Move a.txt to /AlfyAI/b.txt",
				detail: "files.move — /AlfyAI/b.txt",
				reversible: true,
				destructive: false,
				withinAllowlist: true,
				warnings: [],
			},
		});
	});

	it("allowWrites=true: returns a PENDING result, creates a files.move pending row with from/to paths, and never executes inline", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{
				action: "move",
				path: "/AlfyAI/a.txt",
				destinationPath: "/AlfyAI/b.txt",
			},
			LOCAL_MODEL_ID,
			"conv-1",
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("move");
		expect(outcome.modelPayload.pendingWriteId).toBe("pending-move-1");
		expect(outcome.modelPayload.preview).toBeDefined();
		expect(outcome.modelPayload.message.toLowerCase()).toContain("confirm");
		expect(outcome.modelPayload.message).toContain("NOT been moved yet");

		expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
		const call = createPendingWriteMock.mock.calls[0]?.[1];
		expect(call?.op).toMatchObject({
			action: "files.move",
			provider: "nextcloud",
			connectionId: "conn-1",
		});
		// The source + destination both survive to the pending row so the
		// executor can MOVE from -> to on confirm.
		expect(JSON.parse(call?.content ?? "{}")).toEqual({
			fromPath: "/AlfyAI/a.txt",
			toPath: "/AlfyAI/b.txt",
		});
		expect(call?.conversationId).toBe("conv-1");

		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
	});

	it("allowWrites=false: refused, no pending row, secret never decrypted", async () => {
		const conn = makeConn({ allowWrites: false, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{
				action: "move",
				path: "/AlfyAI/a.txt",
				destinationPath: "/AlfyAI/b.txt",
			},
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("turned off");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
		expect(getConnectionSecretMock).not.toHaveBeenCalled();
	});

	it("a destination outside the allowlist is HONORED but flagged in the preview", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		await runFilesTool(
			"user-1",
			{
				action: "move",
				path: "/AlfyAI/a.txt",
				destinationPath: "/Documents/b.txt",
			},
			LOCAL_MODEL_ID,
		);

		const call = createPendingWriteMock.mock.calls[0]?.[1];
		expect(call?.op.target).toMatchObject({
			path: "/Documents/b.txt",
			withinAllowlist: false,
		});
		expect(call?.preview.warnings).toContain("Outside your allowed area");
	});

	it("requires both a source path and a destination path", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const noDest = await runFilesTool(
			"user-1",
			{ action: "move", path: "/AlfyAI/a.txt" },
			LOCAL_MODEL_ID,
		);
		expect(noDest.modelPayload.success).toBe(false);
		expect(noDest.modelPayload.message).toContain("destination");

		const noSource = await runFilesTool(
			"user-1",
			{ action: "move", destinationPath: "/AlfyAI/b.txt" },
			LOCAL_MODEL_ID,
		);
		expect(noSource.modelPayload.success).toBe(false);

		expect(createPendingWriteMock).not.toHaveBeenCalled();
	});
});

describe("runFilesTool — delete action (explicit-confirm write flow, GAP A1)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		nextcloudStatMock.mockReset();
		executeNextcloudWriteMock.mockReset();
		createPendingWriteMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		getConnectionSecretMock.mockResolvedValue("secret");
		createPendingWriteMock.mockResolvedValue({
			id: "pending-delete-1",
			preview: {
				title: "Move old.txt to trash",
				detail: "files.delete — /AlfyAI/old.txt",
				reversible: true,
				destructive: true,
				withinAllowlist: true,
				warnings: [],
			},
		});
	});

	it("allowWrites=true: returns a PENDING result, creates a reversible files.delete pending row, and never executes inline", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "delete", path: "/AlfyAI/old.txt" },
			LOCAL_MODEL_ID,
			"conv-1",
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("delete");
		expect(outcome.modelPayload.pendingWriteId).toBe("pending-delete-1");
		expect(outcome.modelPayload.message.toLowerCase()).toContain("confirm");
		expect(outcome.modelPayload.message).toContain("NOT been deleted yet");

		expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
		const call = createPendingWriteMock.mock.calls[0]?.[1];
		expect(call?.op).toMatchObject({
			action: "files.delete",
			provider: "nextcloud",
			connectionId: "conn-1",
			// delete-to-trash: reversible via Nextcloud's own trashbin.
			reversible: true,
		});
		expect(call?.op.target).toMatchObject({ path: "/AlfyAI/old.txt" });
		expect(call?.conversationId).toBe("conv-1");

		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
	});

	it("allowWrites=false: refused, no pending row, secret never decrypted", async () => {
		const conn = makeConn({ allowWrites: false, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "delete", path: "/AlfyAI/old.txt" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("turned off");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
		expect(getConnectionSecretMock).not.toHaveBeenCalled();
	});

	it("requires a path", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "delete" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("path is required");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
	});
});

// GAP B9a — create_folder write action. Same confirm-gated pending-write
// pattern as save/move/delete: allowWrites checked BEFORE the secret is
// decrypted, a WriteOperation + preview built via the write-guard, a PENDING
// row created, and executeNextcloudWrite NEVER called at proposal time.
describe("runFilesTool — create_folder action (explicit-confirm write flow, GAP B9a)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		executeNextcloudWriteMock.mockReset();
		createPendingWriteMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		getConnectionSecretMock.mockResolvedValue("secret");
		createPendingWriteMock.mockResolvedValue({
			id: "pending-mkcol-1",
			preview: {
				title: "Create folder Reports",
				detail: "files.create_folder — /AlfyAI/Reports",
				reversible: true,
				destructive: false,
				withinAllowlist: true,
				warnings: [],
			},
		});
	});

	it("allowWrites=true: returns a PENDING result, creates a non-destructive files.create_folder pending row, and never executes inline", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "create_folder", path: "/AlfyAI/Reports" },
			LOCAL_MODEL_ID,
			"conv-1",
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("create_folder");
		expect(outcome.modelPayload.pendingWriteId).toBe("pending-mkcol-1");
		expect(outcome.modelPayload.message.toLowerCase()).toContain("confirm");

		expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
		const call = createPendingWriteMock.mock.calls[0]?.[1];
		expect(call?.op).toMatchObject({
			action: "files.create_folder",
			provider: "nextcloud",
			connectionId: "conn-1",
			reversible: true,
			destructive: false,
		});
		expect(call?.op.target).toMatchObject({ path: "/AlfyAI/Reports" });
		expect(call?.conversationId).toBe("conv-1");

		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
	});

	it("allowWrites=false: refused, no pending row, secret never decrypted", async () => {
		const conn = makeConn({ allowWrites: false, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "create_folder", path: "/AlfyAI/Reports" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("turned off");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
		expect(getConnectionSecretMock).not.toHaveBeenCalled();
	});

	it("requires a path", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "create_folder" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("path is required");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
	});
});

// GAP B9b — share_link write action. SENSITIVE: creates PUBLIC exposure of a
// file. Same confirm-gated pending-write pattern, but the preview MUST carry a
// prominent public-exposure warning, and nothing executes at proposal time.
describe("runFilesTool — share_link action (explicit-confirm write flow, GAP B9b)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		executeNextcloudWriteMock.mockReset();
		createPendingWriteMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		getConnectionSecretMock.mockResolvedValue("secret");
		createPendingWriteMock.mockResolvedValue({
			id: "pending-share-1",
			preview: {
				title: "Create a public link for report.pdf",
				detail: "files.share_link — /AlfyAI/report.pdf",
				reversible: true,
				destructive: false,
				withinAllowlist: true,
				warnings: [],
			},
		});
	});

	it("allowWrites=true: returns a PENDING result, the preview carries a public-exposure warning, and never executes inline", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "share_link", path: "/AlfyAI/report.pdf" },
			LOCAL_MODEL_ID,
			"conv-1",
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("share_link");
		expect(outcome.modelPayload.pendingWriteId).toBe("pending-share-1");
		expect(outcome.modelPayload.message.toLowerCase()).toContain("confirm");
		expect(outcome.modelPayload.message.toLowerCase()).toContain("public");

		expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
		const call = createPendingWriteMock.mock.calls[0]?.[1];
		expect(call?.op).toMatchObject({
			action: "files.share_link",
			provider: "nextcloud",
			connectionId: "conn-1",
		});
		expect(call?.op.target).toMatchObject({ path: "/AlfyAI/report.pdf" });
		// The public-exposure warning is the load-bearing invariant for this
		// sensitive write — it MUST be present in the confirm preview.
		expect(
			call?.preview.warnings.some((w: string) =>
				w.toLowerCase().includes("public"),
			),
		).toBe(true);
		expect(call?.conversationId).toBe("conv-1");

		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
	});

	it("allowWrites=false: refused, no pending row, secret never decrypted", async () => {
		const conn = makeConn({ allowWrites: false, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "share_link", path: "/AlfyAI/report.pdf" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("turned off");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
		expect(executeNextcloudWriteMock).not.toHaveBeenCalled();
		expect(getConnectionSecretMock).not.toHaveBeenCalled();
	});

	it("requires a path", async () => {
		const conn = makeConn({ allowWrites: true, writeAllowlist: ["/AlfyAI"] });
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runFilesTool(
			"user-1",
			{ action: "share_link" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("path is required");
		expect(createPendingWriteMock).not.toHaveBeenCalled();
	});
});
