import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// nextcloudListFolders (Redesign R9) loads the connection + decrypts its
// secret via the real store layer (same shape as executeNextcloudWrite), so
// this file runs against a throwaway sqlite db per test — same harness as
// nextcloud-files.write.test.ts's executeNextcloudWrite tests.
let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

beforeEach(() => {
	dbPath = `./data/test-nextcloud-list-folders-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });

	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "user-1@example.com",
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.users)
		.values({
			id: "user-2",
			email: "user-2@example.com",
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

const CONN_CONFIG = {
	serverUrl: "https://cloud.example.com",
	loginName: "alice",
};

async function seedConnection(
	userId: string,
	overrides: {
		capabilities?: string[];
		secret?: string | undefined;
	} = {},
): Promise<string> {
	const { createConnection } = await import("../store");
	const conn = await createConnection({
		userId,
		provider: "nextcloud",
		label: "Nextcloud",
		accountIdentifier: "alice",
		capabilities: overrides.capabilities ?? ["files"],
		status: "connected",
		secret: overrides.secret ?? "app-password-xyz",
		config: CONN_CONFIG,
	});
	return conn.id;
}

function xmlResponse(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "application/xml" },
	});
}

const ROOT_LISTING_MULTISTATUS = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
	<d:response>
		<d:href>/remote.php/dav/files/alice/</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname></d:displayname>
				<d:resourcetype><d:collection/></d:resourcetype>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/remote.php/dav/files/alice/Documents/</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname>Documents</d:displayname>
				<d:resourcetype><d:collection/></d:resourcetype>
				<d:getetag>&quot;documents-etag&quot;</d:getetag>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/remote.php/dav/files/alice/Photos/</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname>Photos</d:displayname>
				<d:resourcetype><d:collection/></d:resourcetype>
				<d:getetag>&quot;photos-etag&quot;</d:getetag>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/remote.php/dav/files/alice/report.pdf</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname>report.pdf</d:displayname>
				<d:getcontentlength>4096</d:getcontentlength>
				<d:getcontenttype>application/pdf</d:getcontenttype>
				<d:resourcetype/>
				<d:getetag>&quot;report-etag&quot;</d:getetag>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

function manyFoldersMultistatus(count: number): string {
	const responses = Array.from({ length: count }, (_, i) => {
		const name = `Folder${i}`;
		return `<d:response>
		<d:href>/remote.php/dav/files/alice/${name}/</d:href>
		<d:propstat>
			<d:prop>
				<d:displayname>${name}</d:displayname>
				<d:resourcetype><d:collection/></d:resourcetype>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>`;
	}).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<d:multistatus xmlns:d="DAV:">\n${responses}\n</d:multistatus>`;
}

describe("nextcloudListFolders", () => {
	it("returns only child folders (not files), as normalized absolute paths", async () => {
		const { nextcloudListFolders } = await import("./nextcloud-files");
		const connectionId = await seedConnection("user-1");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://cloud.example.com/remote.php/dav/files/alice",
				);
				expect(init?.method).toBe("PROPFIND");
				return xmlResponse(207, ROOT_LISTING_MULTISTATUS);
			},
		);

		const folders = await nextcloudListFolders(
			"user-1",
			connectionId,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(folders).toEqual(
			expect.arrayContaining([
				{ path: "/Documents", name: "Documents" },
				{ path: "/Photos", name: "Photos" },
			]),
		);
		expect(folders.some((f) => f.name === "report.pdf")).toBe(false);
		expect(folders).toHaveLength(2);
	});

	it("applies the traversal guard (normalizeNextcloudPath) to the requested path", async () => {
		const { nextcloudListFolders, NextcloudFilesError } = await import(
			"./nextcloud-files"
		);
		const connectionId = await seedConnection("user-1");
		const fetchMock = vi.fn();

		await expect(
			nextcloudListFolders(
				"user-1",
				connectionId,
				{ path: "../secret" },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toThrow(NextcloudFilesError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("caps the returned folders at 200", async () => {
		const { nextcloudListFolders } = await import("./nextcloud-files");
		const connectionId = await seedConnection("user-1");

		const fetchMock = vi.fn(async () =>
			xmlResponse(207, manyFoldersMultistatus(250)),
		);

		const folders = await nextcloudListFolders(
			"user-1",
			connectionId,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(folders).toHaveLength(200);
	});

	it("maps a 401 to a typed needs_reauth error", async () => {
		const { nextcloudListFolders } = await import("./nextcloud-files");
		const connectionId = await seedConnection("user-1");
		const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));

		await expect(
			nextcloudListFolders(
				"user-1",
				connectionId,
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: "needs_reauth" });
	});

	it("throws connection_not_found for another user's connection id", async () => {
		const { nextcloudListFolders } = await import("./nextcloud-files");
		const connectionId = await seedConnection("user-1");

		await expect(
			nextcloudListFolders("user-2", connectionId, {}),
		).rejects.toMatchObject({ code: "connection_not_found" });
	});

	it("throws needs_reauth when the connection has no stored secret", async () => {
		const { nextcloudListFolders } = await import("./nextcloud-files");
		const { createConnection } = await import("../store");
		const conn = await createConnection({
			userId: "user-1",
			provider: "nextcloud",
			label: "Nextcloud",
			accountIdentifier: "alice",
			capabilities: ["files"],
			status: "needs_reauth",
			config: CONN_CONFIG,
		});

		await expect(
			nextcloudListFolders("user-1", conn.id, {}),
		).rejects.toMatchObject({ code: "needs_reauth" });
	});

	it("throws invalid_config for a non-nextcloud / non-files connection", async () => {
		const { nextcloudListFolders } = await import("./nextcloud-files");
		const connectionId = await seedConnection("user-1", {
			capabilities: ["email"],
		});

		await expect(
			nextcloudListFolders("user-1", connectionId, {}),
		).rejects.toMatchObject({ code: "invalid_config" });
	});
});
