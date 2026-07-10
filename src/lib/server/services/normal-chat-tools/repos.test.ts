import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	GitHubError,
	githubCiStatus,
	githubListCommits,
	githubListIssues,
	githubListPullRequests,
	githubListRepos,
	githubReadFile,
	githubSearchCode,
} from "$lib/server/services/connections/providers/github";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";

import {
	reposToolInputSchema,
	runReposTool,
	sanitizeReposToolInput,
} from "./repos";

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveConnectionsForCapability: vi.fn(),
	needsDisambiguation: vi.fn(),
}));
vi.mock("$lib/server/services/connections/providers/github", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/github")
	>("$lib/server/services/connections/providers/github");
	return {
		...actual,
		githubListRepos: vi.fn(),
		githubReadFile: vi.fn(),
		githubListIssues: vi.fn(),
		githubListPullRequests: vi.fn(),
		githubListCommits: vi.fn(),
		githubCiStatus: vi.fn(),
		githubSearchCode: vi.fn(),
	};
});

const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const needsDisambiguationMock = vi.mocked(needsDisambiguation);
const githubListReposMock = vi.mocked(githubListRepos);
const githubReadFileMock = vi.mocked(githubReadFile);
const githubListIssuesMock = vi.mocked(githubListIssues);
const githubListPullRequestsMock = vi.mocked(githubListPullRequests);
const githubListCommitsMock = vi.mocked(githubListCommits);
const githubCiStatusMock = vi.mocked(githubCiStatus);
const githubSearchCodeMock = vi.mocked(githubSearchCode);

function makeConn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "github",
		label: "GitHub",
		accountIdentifier: "octocat",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["repos"],
		config: { baseUrl: "https://api.github.com" },
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function resetAllMocks() {
	resolveConnectionsForCapabilityMock.mockReset();
	needsDisambiguationMock.mockReset();
	githubListReposMock.mockReset();
	githubReadFileMock.mockReset();
	githubListIssuesMock.mockReset();
	githubListPullRequestsMock.mockReset();
	githubListCommitsMock.mockReset();
	githubCiStatusMock.mockReset();
	githubSearchCodeMock.mockReset();
	needsDisambiguationMock.mockReturnValue(false);
}

// ---------------------------------------------------------------------------
// Input schema — no write action exists
// ---------------------------------------------------------------------------

describe("reposToolInputSchema", () => {
	it("only accepts read actions — no write action exists", () => {
		const actionSchema = reposToolInputSchema.shape.action;
		const values = actionSchema.options as readonly string[];
		expect(values).toEqual(
			expect.arrayContaining([
				"list_repos",
				"read_file",
				"list_issues",
				"list_prs",
				"list_commits",
				"ci_status",
				"search_code",
			]),
		);
		for (const value of values) {
			expect(value).not.toMatch(
				/write|create|update|delete|merge|push|comment/i,
			);
		}
		expect(values).toHaveLength(7);
	});
});

describe("sanitizeReposToolInput", () => {
	it("trims strings and drops undefined optional fields", () => {
		expect(
			sanitizeReposToolInput({
				action: "read_file",
				owner: "  octocat  ",
				repo: " alfyai ",
				path: " README.md ",
			}),
		).toEqual({
			action: "read_file",
			owner: "octocat",
			repo: "alfyai",
			path: "README.md",
		});
	});

	it("keeps state/ref/limit when supplied", () => {
		expect(
			sanitizeReposToolInput({
				action: "list_issues",
				owner: "octocat",
				repo: "alfyai",
				state: "open",
				limit: 10,
			}),
		).toEqual({
			action: "list_issues",
			owner: "octocat",
			repo: "alfyai",
			state: "open",
			limit: 10,
		});
	});
});

// ---------------------------------------------------------------------------
// runReposTool
// ---------------------------------------------------------------------------

describe("runReposTool", () => {
	beforeEach(() => {
		resetAllMocks();
	});

	it("degrades gracefully with a note when there is no Repositories connection, without throwing", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const result = await runReposTool("user-1", { action: "list_repos" });

		expect(result.modelPayload.success).toBe(false);
		expect(result.modelPayload.message).toContain(
			"don't have a Repositories connection",
		);
		expect(githubListReposMock).not.toHaveBeenCalled();
	});

	it("surfaces ambiguity when more than one Repositories connection is available", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice GitHub" });
		const connB = makeConn({ id: "conn-b", label: "Bob GitHub" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);
		githubListReposMock.mockResolvedValue([]);

		const result = await runReposTool("user-1", { action: "list_repos" });

		expect(result.modelPayload.message).toContain("2 Repositories connections");
	});

	it("list_repos returns repos and citations", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubListReposMock.mockResolvedValue([
			{
				name: "alfyai",
				fullName: "octocat/alfyai",
				private: true,
				url: "https://github.com/octocat/alfyai",
				defaultBranch: "main",
				fork: false,
			},
		]);

		const result = await runReposTool("user-1", { action: "list_repos" });

		expect(result.modelPayload).toMatchObject({
			success: true,
			action: "list_repos",
			repos: [expect.objectContaining({ fullName: "octocat/alfyai" })],
		});
		expect(result.candidates).toEqual([
			expect.objectContaining({
				id: "repos:https://github.com/octocat/alfyai",
				url: "https://github.com/octocat/alfyai",
			}),
		]);
	});

	it("read_file requires owner, repo, and path", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const missingRepo = await runReposTool("user-1", {
			action: "read_file",
			owner: "octocat",
			path: "README.md",
		});
		expect(missingRepo.modelPayload.success).toBe(false);
		expect(missingRepo.modelPayload.message).toContain("owner");

		const missingPath = await runReposTool("user-1", {
			action: "read_file",
			owner: "octocat",
			repo: "alfyai",
		});
		expect(missingPath.modelPayload.success).toBe(false);
		expect(missingPath.modelPayload.message).toContain("path");

		expect(githubReadFileMock).not.toHaveBeenCalled();
	});

	it("read_file returns file content", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubReadFileMock.mockResolvedValue({
			type: "file",
			path: "README.md",
			content: "Hello world",
			size: 11,
			sha: "abc123",
		});

		const result = await runReposTool("user-1", {
			action: "read_file",
			owner: "octocat",
			repo: "alfyai",
			path: "README.md",
		});

		expect(result.modelPayload).toMatchObject({
			success: true,
			action: "read_file",
			file: { type: "file", content: "Hello world" },
		});
	});

	it("list_issues lists issues scoped to owner/repo", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubListIssuesMock.mockResolvedValue([
			{
				number: 1,
				title: "Bug",
				state: "open",
				url: "https://github.com/octocat/alfyai/issues/1",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
				labels: [],
			},
		]);

		const result = await runReposTool("user-1", {
			action: "list_issues",
			owner: "octocat",
			repo: "alfyai",
		});

		expect(result.modelPayload).toMatchObject({
			success: true,
			issues: [expect.objectContaining({ number: 1 })],
		});
	});

	it("list_prs lists pull requests scoped to owner/repo", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubListPullRequestsMock.mockResolvedValue([
			{
				number: 5,
				title: "Add feature",
				state: "open",
				url: "https://github.com/octocat/alfyai/pull/5",
				draft: false,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		]);

		const result = await runReposTool("user-1", {
			action: "list_prs",
			owner: "octocat",
			repo: "alfyai",
		});

		expect(result.modelPayload).toMatchObject({
			success: true,
			prs: [expect.objectContaining({ number: 5 })],
		});
	});

	it("list_commits lists commits scoped to owner/repo", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubListCommitsMock.mockResolvedValue([
			{
				sha: "abc123",
				message: "Fix bug",
				url: "https://github.com/octocat/alfyai/commit/abc123",
			},
		]);

		const result = await runReposTool("user-1", {
			action: "list_commits",
			owner: "octocat",
			repo: "alfyai",
		});

		expect(result.modelPayload).toMatchObject({
			success: true,
			commits: [expect.objectContaining({ sha: "abc123" })],
		});
	});

	it("ci_status lists CI runs scoped to owner/repo", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubCiStatusMock.mockResolvedValue([
			{
				id: 42,
				status: "completed",
				conclusion: "success",
				headSha: "abc123",
				url: "https://github.com/octocat/alfyai/actions/runs/42",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		]);

		const result = await runReposTool("user-1", {
			action: "ci_status",
			owner: "octocat",
			repo: "alfyai",
		});

		expect(result.modelPayload).toMatchObject({
			success: true,
			ciRuns: [expect.objectContaining({ id: 42 })],
		});
	});

	it("search_code requires a query", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const result = await runReposTool("user-1", { action: "search_code" });

		expect(result.modelPayload.success).toBe(false);
		expect(result.modelPayload.message).toContain("query");
		expect(githubSearchCodeMock).not.toHaveBeenCalled();
	});

	it("search_code searches across accessible repos", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubSearchCodeMock.mockResolvedValue([
			{
				name: "index.ts",
				path: "src/index.ts",
				repository: "octocat/alfyai",
				url: "https://github.com/octocat/alfyai/blob/main/src/index.ts",
			},
		]);

		const result = await runReposTool("user-1", {
			action: "search_code",
			query: "handleRequest",
		});

		expect(result.modelPayload).toMatchObject({
			success: true,
			codeResults: [expect.objectContaining({ name: "index.ts" })],
		});
	});

	it("maps adapter errors to a clean, user-facing message without leaking internals", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubListReposMock.mockRejectedValue(
			new GitHubError("needs_reauth detail", "needs_reauth"),
		);

		const result = await runReposTool("user-1", { action: "list_repos" });

		expect(result.modelPayload.success).toBe(false);
		expect(result.modelPayload.message).toContain("reconnected");
	});
});
