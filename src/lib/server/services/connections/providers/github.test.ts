import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

function seedUser(userId: string) {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

beforeEach(() => {
	dbPath = `./data/test-connections-github-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const USER_ID = "userA";
const DEFAULT_BASE_URL = "https://api.github.com";

async function seedGitHubConnection(
	overrides: { token?: string; baseUrl?: string } = {},
) {
	const { createConnection } = await import("../store");
	return createConnection({
		userId: USER_ID,
		provider: "github",
		label: "GitHub",
		accountIdentifier: "octocat",
		capabilities: ["repos"],
		status: "connected",
		secret: overrides.token ?? "ghp_secret_token",
		config: { baseUrl: overrides.baseUrl ?? DEFAULT_BASE_URL },
	});
}

// ---------------------------------------------------------------------------
// githubConnect
// ---------------------------------------------------------------------------

describe("githubConnect", () => {
	it("validates the token against /user and stores it (never plaintext-logged) with the default base URL", async () => {
		seedUser(USER_ID);
		const { githubConnect } = await import("./github");
		const { getConnectionSecret } = await import("../store");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer token-abc");
				expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
				expect(headers.get("User-Agent")).toBeTruthy();
				if (url === `${DEFAULT_BASE_URL}/user`) {
					return jsonResponse(200, { login: "octocat" });
				}
				throw new Error(`unexpected url ${url}`);
			},
		);

		const { connection } = await githubConnect({
			userId: USER_ID,
			token: "token-abc",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.provider).toBe("github");
		expect(connection.accountIdentifier).toBe("octocat");
		expect(connection.capabilities).toEqual(["repos"]);
		expect(connection.status).toBe("connected");
		expect(connection.hasSecret).toBe(true);
		expect("secret" in connection).toBe(false);
		expect(connection.config).toEqual({ baseUrl: DEFAULT_BASE_URL });

		// The raw token must never appear anywhere in the stored/serialized DTO.
		expect(JSON.stringify(connection)).not.toContain("token-abc");

		const decrypted = await getConnectionSecret(USER_ID, connection.id);
		expect(decrypted).toBe("token-abc");
	});

	it("accepts a custom (Gitea/GHE) base URL, normalizing a bare host to https://", async () => {
		seedUser(USER_ID);
		const { githubConnect } = await import("./github");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://git.example.com/api/v1/user") {
				return jsonResponse(200, { login: "octocat" });
			}
			throw new Error(`unexpected url ${url}`);
		});

		const { connection } = await githubConnect({
			userId: USER_ID,
			token: "token-abc",
			baseUrl: "git.example.com/api/v1",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.config).toEqual({
			baseUrl: "https://git.example.com/api/v1",
		});
	});

	it.each([
		["a plain http:// base URL", "http://git.example.com"],
		["a loopback IPv4 host", "https://127.0.0.1:3000"],
		["a private RFC1918 host", "https://192.168.1.10:3000"],
		["the cloud metadata address", "https://169.254.169.254/latest"],
	])("rejects %s as invalid_config without ever calling fetch (SSRF guard)", async (_label, baseUrl) => {
		seedUser(USER_ID);
		const { githubConnect, GitHubError } = await import("./github");
		const fetchMock = vi.fn();

		try {
			await githubConnect({
				userId: USER_ID,
				token: "token-abc",
				baseUrl,
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected githubConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubError);
			expect((err as InstanceType<typeof GitHubError>).code).toBe(
				"invalid_config",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a 401 on /user surfaces a clear invalid_token error with no token in the message", async () => {
		seedUser(USER_ID);
		const { githubConnect, GitHubError } = await import("./github");

		const fetchMock = vi.fn(async () =>
			jsonResponse(401, { message: "Bad credentials" }),
		);

		try {
			await githubConnect({
				userId: USER_ID,
				token: "wrong-token",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected githubConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubError);
			expect((err as InstanceType<typeof GitHubError>).code).toBe(
				"invalid_token",
			);
			expect((err as Error).message).not.toContain("wrong-token");
			expect((err as Error).message.toLowerCase()).toContain("invalid");
		}
	});

	it("requires a non-empty token without ever calling fetch", async () => {
		seedUser(USER_ID);
		const { githubConnect, GitHubError } = await import("./github");
		const fetchMock = vi.fn();

		try {
			await githubConnect({
				userId: USER_ID,
				token: "   ",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected githubConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubError);
			expect((err as InstanceType<typeof GitHubError>).code).toBe(
				"invalid_config",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("re-connecting the same GitHub login updates the existing connection instead of creating a duplicate", async () => {
		seedUser(USER_ID);
		const { githubConnect } = await import("./github");
		const { listConnectionsForUser } = await import("../store");

		const fetchMock = vi.fn(async () =>
			jsonResponse(200, { login: "octocat" }),
		);

		const first = await githubConnect({
			userId: USER_ID,
			token: "token-one",
			fetch: fetchMock as unknown as typeof fetch,
		});
		const second = await githubConnect({
			userId: USER_ID,
			token: "token-two",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(second.connection.id).toBe(first.connection.id);
		const all = await listConnectionsForUser(USER_ID);
		expect(all.filter((c) => c.provider === "github")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// checkHealth (adapter)
// ---------------------------------------------------------------------------

describe("github checkHealth", () => {
	it("reports connected on a 200 /user response", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubAdapter } = await import("./github");

		const fetchMock = vi.fn(async () =>
			jsonResponse(200, { login: "octocat" }),
		);

		const result = await githubAdapter.checkHealth(
			conn.hasSecret ? "ghp_secret_token" : "",
			conn,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(result).toEqual({ status: "connected", detail: null });
	});

	it("reports needs_reauth on a 401", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubAdapter } = await import("./github");

		const fetchMock = vi.fn(async () =>
			jsonResponse(401, { message: "Bad credentials" }),
		);

		const result = await githubAdapter.checkHealth("ghp_secret_token", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(result.status).toBe("needs_reauth");
	});

	it("reports error on a non-401 failure without leaking the response body", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubAdapter } = await import("./github");

		const fetchMock = vi.fn(async () =>
			jsonResponse(500, { message: "SECRET_INTERNAL_DETAIL" }),
		);

		const result = await githubAdapter.checkHealth("ghp_secret_token", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(result.status).toBe("error");
		expect(result.detail).not.toContain("SECRET_INTERNAL_DETAIL");
	});

	it("requiresSecret is true", async () => {
		const { githubAdapter } = await import("./github");
		expect(githubAdapter.requiresSecret).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Read methods
// ---------------------------------------------------------------------------

describe("githubListRepos", () => {
	it("lists repos sorted by pushed, mapping the relevant fields", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubListRepos } = await import("./github");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("/user/repos");
			expect(url).toContain("sort=pushed");
			return jsonResponse(200, [
				{
					name: "alfyai",
					full_name: "octocat/alfyai",
					private: true,
					description: "An AI assistant",
					html_url: "https://github.com/octocat/alfyai",
					default_branch: "main",
					pushed_at: "2026-01-01T00:00:00Z",
					language: "TypeScript",
					fork: false,
				},
			]);
		});

		const repos = await githubListRepos(
			USER_ID,
			conn.id,
			{},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(repos).toEqual([
			{
				name: "alfyai",
				fullName: "octocat/alfyai",
				private: true,
				description: "An AI assistant",
				url: "https://github.com/octocat/alfyai",
				defaultBranch: "main",
				pushedAt: "2026-01-01T00:00:00Z",
				language: "TypeScript",
				fork: false,
			},
		]);
	});

	it("maps a non-2xx response to a clean request_failed error without leaking the body", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubListRepos, GitHubError } = await import("./github");

		const fetchMock = vi.fn(async () =>
			jsonResponse(500, { message: "SECRET_INTERNAL_DETAIL" }),
		);

		try {
			await githubListRepos(
				USER_ID,
				conn.id,
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected githubListRepos to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubError);
			expect((err as InstanceType<typeof GitHubError>).code).toBe(
				"request_failed",
			);
			expect((err as Error).message).not.toContain("SECRET_INTERNAL_DETAIL");
		}
	});

	it("marks the connection needs_reauth on a 401 and throws needs_reauth", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubListRepos, GitHubError } = await import("./github");
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async () =>
			jsonResponse(401, { message: "Bad credentials" }),
		);

		try {
			await githubListRepos(
				USER_ID,
				conn.id,
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected githubListRepos to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubError);
			expect((err as InstanceType<typeof GitHubError>).code).toBe(
				"needs_reauth",
			);
		}

		const updated = await getConnection(USER_ID, conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});
});

describe("githubReadFile", () => {
	it("decodes base64 file content", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubReadFile } = await import("./github");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("/repos/octocat/alfyai/contents/README.md");
			return jsonResponse(200, {
				type: "file",
				path: "README.md",
				sha: "abc123",
				size: 11,
				content: Buffer.from("Hello world").toString("base64"),
				encoding: "base64",
			});
		});

		const result = await githubReadFile(
			USER_ID,
			conn.id,
			{ owner: "octocat", repo: "alfyai", path: "README.md" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({
			type: "file",
			path: "README.md",
			content: "Hello world",
			size: 11,
			sha: "abc123",
		});
	});

	it("returns a directory listing when the path is a directory", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubReadFile } = await import("./github");

		const fetchMock = vi.fn(async () =>
			jsonResponse(200, [
				{ name: "index.ts", path: "src/index.ts", type: "file" },
				{ name: "lib", path: "src/lib", type: "dir" },
			]),
		);

		const result = await githubReadFile(
			USER_ID,
			conn.id,
			{ owner: "octocat", repo: "alfyai", path: "src" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({
			type: "dir",
			path: "src",
			entries: [
				{ name: "index.ts", path: "src/index.ts", type: "file" },
				{ name: "lib", path: "src/lib", type: "dir" },
			],
		});
	});

	it("maps a 404 to a clean not_found error", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubReadFile, GitHubError } = await import("./github");

		const fetchMock = vi.fn(async () =>
			jsonResponse(404, { message: "Not Found" }),
		);

		try {
			await githubReadFile(
				USER_ID,
				conn.id,
				{ owner: "octocat", repo: "alfyai", path: "missing.md" },
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected githubReadFile to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubError);
			expect((err as InstanceType<typeof GitHubError>).code).toBe("not_found");
		}
	});
});

describe("githubListIssues", () => {
	it("lists issues, filtering out entries that are actually pull requests", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubListIssues } = await import("./github");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("/repos/octocat/alfyai/issues");
			return jsonResponse(200, [
				{
					number: 1,
					title: "Bug report",
					state: "open",
					html_url: "https://github.com/octocat/alfyai/issues/1",
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-02T00:00:00Z",
					user: { login: "reporter" },
					labels: [{ name: "bug" }],
				},
				{
					number: 2,
					title: "Actually a PR",
					state: "open",
					html_url: "https://github.com/octocat/alfyai/issues/2",
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-02T00:00:00Z",
					pull_request: { url: "https://api.github.com/..." },
				},
			]);
		});

		const issues = await githubListIssues(
			USER_ID,
			conn.id,
			{ owner: "octocat", repo: "alfyai" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(issues).toEqual([
			{
				number: 1,
				title: "Bug report",
				state: "open",
				url: "https://github.com/octocat/alfyai/issues/1",
				author: "reporter",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-02T00:00:00Z",
				labels: ["bug"],
			},
		]);
	});
});

describe("githubListPullRequests", () => {
	it("lists pull requests, mapping head/base refs", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubListPullRequests } = await import("./github");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("/repos/octocat/alfyai/pulls");
			return jsonResponse(200, [
				{
					number: 5,
					title: "Add feature",
					state: "open",
					html_url: "https://github.com/octocat/alfyai/pull/5",
					draft: false,
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-02T00:00:00Z",
					user: { login: "contributor" },
					head: { ref: "feature-branch" },
					base: { ref: "main" },
				},
			]);
		});

		const prs = await githubListPullRequests(
			USER_ID,
			conn.id,
			{ owner: "octocat", repo: "alfyai" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(prs).toEqual([
			{
				number: 5,
				title: "Add feature",
				state: "open",
				url: "https://github.com/octocat/alfyai/pull/5",
				author: "contributor",
				draft: false,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-02T00:00:00Z",
				headRef: "feature-branch",
				baseRef: "main",
			},
		]);
	});
});

describe("githubListCommits", () => {
	it("lists commits, mapping author name/date", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubListCommits } = await import("./github");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("/repos/octocat/alfyai/commits");
			return jsonResponse(200, [
				{
					sha: "abc123def456",
					html_url: "https://github.com/octocat/alfyai/commit/abc123def456",
					commit: {
						message: "Fix bug\n\nLonger description",
						author: { name: "Jane Dev", date: "2026-01-01T00:00:00Z" },
					},
				},
			]);
		});

		const commits = await githubListCommits(
			USER_ID,
			conn.id,
			{ owner: "octocat", repo: "alfyai" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(commits).toEqual([
			{
				sha: "abc123def456",
				message: "Fix bug\n\nLonger description",
				author: "Jane Dev",
				date: "2026-01-01T00:00:00Z",
				url: "https://github.com/octocat/alfyai/commit/abc123def456",
			},
		]);
	});
});

describe("githubCiStatus", () => {
	it("lists recent CI/Actions runs", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubCiStatus } = await import("./github");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("/repos/octocat/alfyai/actions/runs");
			return jsonResponse(200, {
				total_count: 1,
				workflow_runs: [
					{
						id: 42,
						name: "CI",
						status: "completed",
						conclusion: "success",
						head_branch: "main",
						head_sha: "abc123",
						html_url: "https://github.com/octocat/alfyai/actions/runs/42",
						created_at: "2026-01-01T00:00:00Z",
						updated_at: "2026-01-01T00:05:00Z",
					},
				],
			});
		});

		const runs = await githubCiStatus(
			USER_ID,
			conn.id,
			{ owner: "octocat", repo: "alfyai" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(runs).toEqual([
			{
				id: 42,
				name: "CI",
				status: "completed",
				conclusion: "success",
				headBranch: "main",
				headSha: "abc123",
				url: "https://github.com/octocat/alfyai/actions/runs/42",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:05:00Z",
			},
		]);
	});
});

describe("githubSearchCode", () => {
	it("searches code and maps results", async () => {
		seedUser(USER_ID);
		const conn = await seedGitHubConnection();
		const { githubSearchCode } = await import("./github");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("/search/code");
			expect(url).toContain("q=");
			return jsonResponse(200, {
				total_count: 1,
				items: [
					{
						name: "index.ts",
						path: "src/index.ts",
						html_url:
							"https://github.com/octocat/alfyai/blob/main/src/index.ts",
						repository: { full_name: "octocat/alfyai" },
					},
				],
			});
		});

		const results = await githubSearchCode(
			USER_ID,
			conn.id,
			{ query: "handleRequest repo:octocat/alfyai" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(results).toEqual([
			{
				name: "index.ts",
				path: "src/index.ts",
				repository: "octocat/alfyai",
				url: "https://github.com/octocat/alfyai/blob/main/src/index.ts",
			},
		]);
	});
});

describe("githubAuthorizedRequest connection lifecycle", () => {
	it("throws connection_not_found for an unknown connection id", async () => {
		seedUser(USER_ID);
		const { githubListRepos, GitHubError } = await import("./github");

		try {
			await githubListRepos(
				USER_ID,
				"does-not-exist",
				{},
				{ fetch: vi.fn() as unknown as typeof fetch },
			);
			throw new Error("expected githubListRepos to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubError);
			expect((err as InstanceType<typeof GitHubError>).code).toBe(
				"connection_not_found",
			);
		}
	});
});
