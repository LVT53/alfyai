import { describe, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "../store";

function makeConn(config: Record<string, unknown>): ConnectionPublic {
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
		config,
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

const CONN_CONFIG = {
	serverUrl: "https://cloud.example.com",
	loginName: "alice",
};

const LIST_FOLDER_MULTISTATUS = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
	<d:response>
		<d:href>/remote.php/dav/files/alice/Documents/</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname>Documents</d:displayname>
				<d:resourcetype><d:collection/></d:resourcetype>
				<d:getetag>&quot;self-etag&quot;</d:getetag>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/remote.php/dav/files/alice/Documents/Notes/</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname>Notes</d:displayname>
				<d:resourcetype><d:collection/></d:resourcetype>
				<d:getetag>&quot;notes-etag&quot;</d:getetag>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/remote.php/dav/files/alice/Documents/report.pdf</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname>report.pdf</d:displayname>
				<d:getcontentlength>4096</d:getcontentlength>
				<d:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</d:getlastmodified>
				<d:getcontenttype>application/pdf</d:getcontenttype>
				<d:resourcetype/>
				<d:getetag>&quot;report-etag&quot;</d:getetag>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

function statMultistatus(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
	<d:response>
		<d:href>/remote.php/dav/files/alice/report.pdf</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname>report.pdf</d:displayname>
				<d:getcontentlength>2048</d:getcontentlength>
				<d:getlastmodified>Tue, 02 Jan 2024 00:00:00 GMT</d:getlastmodified>
				<d:getcontenttype>application/pdf</d:getcontenttype>
				<d:resourcetype/>
				<d:getetag>&quot;stat-etag&quot;</d:getetag>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;
}

const SEARCH_MULTISTATUS = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
	<d:response>
		<d:href>/remote.php/dav/files/alice/Documents/budget.xlsx</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname>budget.xlsx</d:displayname>
				<d:getcontentlength>1024</d:getcontentlength>
				<d:getlastmodified>Wed, 03 Jan 2024 00:00:00 GMT</d:getlastmodified>
				<d:getcontenttype>application/vnd.openxmlformats</d:getcontenttype>
				<d:resourcetype/>
				<d:getetag>&quot;budget-etag&quot;</d:getetag>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/remote.php/dav/files/alice/Archive/old-budget.xlsx</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname>old-budget.xlsx</d:displayname>
				<d:getcontentlength>512</d:getcontentlength>
				<d:getlastmodified>Thu, 04 Jan 2024 00:00:00 GMT</d:getlastmodified>
				<d:getcontenttype>application/vnd.openxmlformats</d:getcontenttype>
				<d:resourcetype/>
				<d:getetag>&quot;old-budget-etag&quot;</d:getetag>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

function xmlResponse(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "application/xml" },
	});
}

describe("normalizeNextcloudPath", () => {
	it("strips a leading slash", async () => {
		const { normalizeNextcloudPath } = await import("./nextcloud-files");
		expect(normalizeNextcloudPath("/a/b")).toBe("a/b");
	});

	it("collapses a '..' segment against its preceding sibling", async () => {
		const { normalizeNextcloudPath } = await import("./nextcloud-files");
		expect(normalizeNextcloudPath("a/../b")).toBe("b");
	});

	it("throws when a leading '..' would escape the root", async () => {
		const { normalizeNextcloudPath } = await import("./nextcloud-files");
		expect(() => normalizeNextcloudPath("../secret")).toThrow();
	});

	it("throws when '..' segments outnumber preceding segments", async () => {
		const { normalizeNextcloudPath } = await import("./nextcloud-files");
		expect(() => normalizeNextcloudPath("a/../../x")).toThrow();
	});

	it("normalizes the root to an empty string", async () => {
		const { normalizeNextcloudPath } = await import("./nextcloud-files");
		expect(normalizeNextcloudPath("/")).toBe("");
		expect(normalizeNextcloudPath("")).toBe("");
	});
});

describe("nextcloudListFolder", () => {
	it("parses a 207 multistatus into NcFile[], excluding the self entry", async () => {
		const { nextcloudListFolder } = await import("./nextcloud-files");
		const conn = makeConn(CONN_CONFIG);

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://cloud.example.com/remote.php/dav/files/alice/Documents",
				);
				expect(init?.method).toBe("PROPFIND");
				const headers = new Headers(init?.headers);
				expect(headers.get("Depth")).toBe("1");
				expect(headers.get("Authorization")).toBe(
					`Basic ${Buffer.from("alice:app-password-xyz").toString("base64")}`,
				);
				return xmlResponse(207, LIST_FOLDER_MULTISTATUS);
			},
		);

		const files = await nextcloudListFolder(
			conn,
			"app-password-xyz",
			"Documents",
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(files).toHaveLength(2);

		const notes = files.find((f) => f.name === "Notes");
		expect(notes).toMatchObject({
			path: "Documents/Notes",
			isDir: true,
			etag: '"notes-etag"',
		});

		const report = files.find((f) => f.name === "report.pdf");
		expect(report).toMatchObject({
			path: "Documents/report.pdf",
			isDir: false,
			size: 4096,
			etag: '"report-etag"',
			contentType: "application/pdf",
		});

		expect(files.some((f) => f.path === "Documents")).toBe(false);
	});
});

describe("nextcloudReadFile", () => {
	it("returns bytes, etag and contentType", async () => {
		const { nextcloudReadFile } = await import("./nextcloud-files");
		const conn = makeConn(CONN_CONFIG);
		const content = new TextEncoder().encode("hello world");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://cloud.example.com/remote.php/dav/files/alice/Documents/report.pdf",
				);
				expect(init?.method).toBe("GET");
				return new Response(content, {
					status: 200,
					headers: {
						ETag: '"report-etag"',
						"Content-Type": "application/pdf",
						"Content-Length": String(content.byteLength),
					},
				});
			},
		);

		const result = await nextcloudReadFile(
			conn,
			"app-password-xyz",
			"Documents/report.pdf",
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(new TextDecoder().decode(result.bytes)).toBe("hello world");
		expect(result.etag).toBe('"report-etag"');
		expect(result.contentType).toBe("application/pdf");
	});

	it("refuses a file whose Content-Length exceeds the 25MB cap", async () => {
		const { nextcloudReadFile } = await import("./nextcloud-files");
		const conn = makeConn(CONN_CONFIG);

		const fetchMock = vi.fn(async () => {
			return new Response(new Uint8Array(1), {
				status: 200,
				headers: {
					ETag: '"huge-etag"',
					"Content-Type": "application/octet-stream",
					"Content-Length": String(25 * 1024 * 1024 + 1),
				},
			});
		});

		await expect(
			nextcloudReadFile(conn, "app-password-xyz", "huge.bin", {
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow(/exceeds/i);
	});
});

describe("nextcloudSearch", () => {
	it("returns matching NcFile[] for a query via server-side SEARCH", async () => {
		const { nextcloudSearch } = await import("./nextcloud-files");
		const conn = makeConn(CONN_CONFIG);

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("https://cloud.example.com/remote.php/dav/");
				expect(init?.method).toBe("SEARCH");
				expect(String(init?.body)).toContain("budget");
				return xmlResponse(207, SEARCH_MULTISTATUS);
			},
		);

		const files = await nextcloudSearch(conn, "app-password-xyz", "budget", {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(files).toHaveLength(2);
		expect(files.map((f) => f.name).sort()).toEqual([
			"budget.xlsx",
			"old-budget.xlsx",
		]);
	});
});

describe("nextcloudStat", () => {
	it("returns an NcFile for an existing path", async () => {
		const { nextcloudStat } = await import("./nextcloud-files");
		const conn = makeConn(CONN_CONFIG);

		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				expect(headers.get("Depth")).toBe("0");
				return xmlResponse(207, statMultistatus());
			},
		);

		const file = await nextcloudStat(conn, "app-password-xyz", "report.pdf", {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(file).toMatchObject({
			name: "report.pdf",
			path: "report.pdf",
			isDir: false,
			size: 2048,
			etag: '"stat-etag"',
		});
	});

	it("returns null for a missing path (404)", async () => {
		const { nextcloudStat } = await import("./nextcloud-files");
		const conn = makeConn(CONN_CONFIG);

		const fetchMock = vi.fn(async () => new Response("", { status: 404 }));

		const file = await nextcloudStat(conn, "app-password-xyz", "missing.txt", {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(file).toBeNull();
	});
});

describe("401 handling", () => {
	it("maps a 401 to a typed needs_reauth error with no password in the message", async () => {
		const { nextcloudListFolder, NextcloudFilesError } = await import(
			"./nextcloud-files"
		);
		const conn = makeConn(CONN_CONFIG);

		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		let caught: unknown;
		try {
			await nextcloudListFolder(conn, "super-secret-password", "Documents", {
				fetch: fetchMock as unknown as typeof fetch,
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(NextcloudFilesError);
		expect((caught as InstanceType<typeof NextcloudFilesError>).code).toBe(
			"needs_reauth",
		);
		expect((caught as Error).message).not.toContain("super-secret-password");
	});
});

describe("path traversal guard integration", () => {
	it("rejects a traversal attempt before any fetch is made", async () => {
		const { nextcloudListFolder } = await import("./nextcloud-files");
		const conn = makeConn(CONN_CONFIG);
		const fetchMock = vi.fn();

		await expect(
			nextcloudListFolder(conn, "app-password-xyz", "../../etc/passwd", {
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
