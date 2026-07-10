import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
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
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));

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
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);

const LOCAL_MODEL_ID = "model1";
const CLOUD_MODEL_ID = "gpt-cloud";

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
	hasLocalDistillEnabledMock.mockReset();
	isCloudModelMock.mockReset();
	distillConnectorPayloadMock.mockReset();
	needsDisambiguationMock.mockReturnValue(false);
	hasLocalDistillEnabledMock.mockResolvedValue(false);
	isCloudModelMock.mockResolvedValue(false);
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

		const result = await runReposTool(
			"user-1",
			{ action: "list_repos" },
			LOCAL_MODEL_ID,
		);

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

		const result = await runReposTool(
			"user-1",
			{ action: "list_repos" },
			LOCAL_MODEL_ID,
		);

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

		const result = await runReposTool(
			"user-1",
			{ action: "list_repos" },
			LOCAL_MODEL_ID,
		);

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

		const missingRepo = await runReposTool(
			"user-1",
			{
				action: "read_file",
				owner: "octocat",
				path: "README.md",
			},
			LOCAL_MODEL_ID,
		);
		expect(missingRepo.modelPayload.success).toBe(false);
		expect(missingRepo.modelPayload.message).toContain("owner");

		const missingPath = await runReposTool(
			"user-1",
			{
				action: "read_file",
				owner: "octocat",
				repo: "alfyai",
			},
			LOCAL_MODEL_ID,
		);
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

		const result = await runReposTool(
			"user-1",
			{
				action: "read_file",
				owner: "octocat",
				repo: "alfyai",
				path: "README.md",
			},
			LOCAL_MODEL_ID,
		);

		expect(result.modelPayload).toMatchObject({
			success: true,
			action: "read_file",
			file: { type: "file", content: "Hello world" },
		});
	});

	it("read_file citation links to github.com for the default (api.github.com) base URL", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubReadFileMock.mockResolvedValue({
			type: "file",
			path: "README.md",
			content: "Hello world",
			size: 11,
			sha: "abc123",
		});

		const result = await runReposTool(
			"user-1",
			{
				action: "read_file",
				owner: "octocat",
				repo: "alfyai",
				path: "README.md",
			},
			LOCAL_MODEL_ID,
		);

		expect(result.modelPayload.citations).toEqual([
			{
				label: "README.md",
				url: "https://github.com/octocat/alfyai/blob/HEAD/README.md",
			},
		]);
	});

	it("read_file citation derives the web URL from a GitHub Enterprise (api/v3) base URL", async () => {
		const conn = makeConn({
			config: { baseUrl: "https://github.example.com/api/v3" },
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubReadFileMock.mockResolvedValue({
			type: "file",
			path: "README.md",
			content: "Hello world",
			size: 11,
			sha: "abc123",
		});

		const result = await runReposTool(
			"user-1",
			{
				action: "read_file",
				owner: "octocat",
				repo: "alfyai",
				path: "README.md",
			},
			LOCAL_MODEL_ID,
		);

		expect(result.modelPayload.citations).toEqual([
			{
				label: "README.md",
				url: "https://github.example.com/octocat/alfyai/blob/HEAD/README.md",
			},
		]);
	});

	it("read_file citation derives the web URL from a Gitea (api/v1) base URL", async () => {
		const conn = makeConn({
			config: { baseUrl: "https://gitea.example.com/api/v1" },
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubReadFileMock.mockResolvedValue({
			type: "file",
			path: "README.md",
			content: "Hello world",
			size: 11,
			sha: "abc123",
		});

		const result = await runReposTool(
			"user-1",
			{
				action: "read_file",
				owner: "octocat",
				repo: "alfyai",
				path: "README.md",
			},
			LOCAL_MODEL_ID,
		);

		expect(result.modelPayload.citations).toEqual([
			{
				label: "README.md",
				url: "https://gitea.example.com/octocat/alfyai/blob/HEAD/README.md",
			},
		]);
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

		const result = await runReposTool(
			"user-1",
			{
				action: "list_issues",
				owner: "octocat",
				repo: "alfyai",
			},
			LOCAL_MODEL_ID,
		);

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

		const result = await runReposTool(
			"user-1",
			{
				action: "list_prs",
				owner: "octocat",
				repo: "alfyai",
			},
			LOCAL_MODEL_ID,
		);

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

		const result = await runReposTool(
			"user-1",
			{
				action: "list_commits",
				owner: "octocat",
				repo: "alfyai",
			},
			LOCAL_MODEL_ID,
		);

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

		const result = await runReposTool(
			"user-1",
			{
				action: "ci_status",
				owner: "octocat",
				repo: "alfyai",
			},
			LOCAL_MODEL_ID,
		);

		expect(result.modelPayload).toMatchObject({
			success: true,
			ciRuns: [expect.objectContaining({ id: 42 })],
		});
	});

	it("search_code requires a query", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const result = await runReposTool(
			"user-1",
			{ action: "search_code" },
			LOCAL_MODEL_ID,
		);

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

		const result = await runReposTool(
			"user-1",
			{
				action: "search_code",
				query: "handleRequest",
			},
			LOCAL_MODEL_ID,
		);

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

		const result = await runReposTool(
			"user-1",
			{ action: "list_repos" },
			LOCAL_MODEL_ID,
		);

		expect(result.modelPayload.success).toBe(false);
		expect(result.modelPayload.message).toContain("reconnected");
	});
});

// ---------------------------------------------------------------------------
// Locality Option A distillation gate — repos is the last connector tool to
// wire this: raw GitHub content (file source, issue/PR titles, commit
// messages, code-search repo/path) must never reach a cloud model when the
// user has opted in to local distillation. Mirrors contacts.test.ts's /
// media.test.ts's gate coverage.
// ---------------------------------------------------------------------------

describe("runReposTool — locality Option A distillation gate", () => {
	beforeEach(() => {
		resetAllMocks();
	});

	it("read_file: Option A off — raw file content is returned unchanged and distill is not called", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubReadFileMock.mockResolvedValue({
			type: "file",
			path: "secrets.env",
			content: "API_KEY=super-secret-value",
			size: 27,
			sha: "abc123",
		});
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const result = await runReposTool(
			"user-1",
			{
				action: "read_file",
				owner: "octocat",
				repo: "alfyai",
				path: "secrets.env",
			},
			CLOUD_MODEL_ID,
		);

		expect(JSON.stringify(result.modelPayload)).toContain(
			"API_KEY=super-secret-value",
		);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("read_file: Option A on + local model — raw file content is returned unchanged and distill is not called", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubReadFileMock.mockResolvedValue({
			type: "file",
			path: "secrets.env",
			content: "API_KEY=super-secret-value",
			size: 27,
			sha: "abc123",
		});
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(false);

		const result = await runReposTool(
			"user-1",
			{
				action: "read_file",
				owner: "octocat",
				repo: "alfyai",
				path: "secrets.env",
			},
			LOCAL_MODEL_ID,
		);

		expect(JSON.stringify(result.modelPayload)).toContain(
			"API_KEY=super-secret-value",
		);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("read_file: Option A on + cloud model — raw file content is NOT present verbatim in the model-facing payload; a distilled summary replaces it", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubReadFileMock.mockResolvedValue({
			type: "file",
			path: "secrets.env",
			content: "API_KEY=super-secret-value",
			size: 27,
			sha: "abc123",
		});
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "A dotenv-style config file with one API key entry.",
		});

		const result = await runReposTool(
			"user-1",
			{
				action: "read_file",
				owner: "octocat",
				repo: "alfyai",
				path: "secrets.env",
			},
			CLOUD_MODEL_ID,
		);

		const serialized = JSON.stringify(result.modelPayload);
		expect(serialized).not.toContain("API_KEY=super-secret-value");
		expect(result.modelPayload.file).toMatchObject({
			type: "file",
			content: "",
		});
		expect(result.modelPayload.message).toContain(
			"A dotenv-style config file with one API key entry.",
		);
		expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				capability: "repos",
				rawText: expect.stringContaining("API_KEY=super-secret-value"),
			}),
		);
	});

	it("read_file: Option A on + cloud model + distill unavailable — raw content is withheld, not leaked", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubReadFileMock.mockResolvedValue({
			type: "file",
			path: "secrets.env",
			content: "API_KEY=super-secret-value",
			size: 27,
			sha: "abc123",
		});
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const result = await runReposTool(
			"user-1",
			{
				action: "read_file",
				owner: "octocat",
				repo: "alfyai",
				path: "secrets.env",
			},
			CLOUD_MODEL_ID,
		);

		const serialized = JSON.stringify(result.modelPayload);
		expect(serialized).not.toContain("API_KEY=super-secret-value");
		expect(result.modelPayload.message).toContain("withheld");
	});

	it("list_issues: Option A on + cloud model — issue titles are stripped from the payload AND citations, Sources-tab candidates keep the real title", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubListIssuesMock.mockResolvedValue([
			{
				number: 1,
				title: "Layoff plan leak",
				state: "open",
				url: "https://github.com/octocat/alfyai/issues/1",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
				labels: [],
			},
		]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One open issue about an internal planning topic.",
		});

		const result = await runReposTool(
			"user-1",
			{ action: "list_issues", owner: "octocat", repo: "alfyai" },
			CLOUD_MODEL_ID,
		);

		const serialized = JSON.stringify(result.modelPayload);
		expect(serialized).not.toContain("Layoff plan leak");
		expect(result.candidates).toEqual([
			expect.objectContaining({
				title: expect.stringContaining("Layoff plan leak"),
			}),
		]);
	});

	it("list_commits: Option A on + cloud model — commit messages are stripped from the payload AND citations", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubListCommitsMock.mockResolvedValue([
			{
				sha: "abc123",
				message: "Fix credential leak in prod config",
				url: "https://github.com/octocat/alfyai/commit/abc123",
			},
		]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One commit fixing a configuration issue.",
		});

		const result = await runReposTool(
			"user-1",
			{ action: "list_commits", owner: "octocat", repo: "alfyai" },
			CLOUD_MODEL_ID,
		);

		const serialized = JSON.stringify(result.modelPayload);
		expect(serialized).not.toContain("Fix credential leak in prod config");
	});

	it("search_code: Option A on + cloud model — repository/path text is stripped from the payload AND citations", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		githubSearchCodeMock.mockResolvedValue([
			{
				name: "keys.ts",
				path: "internal/secrets/keys.ts",
				repository: "octocat/private-infra",
				url: "https://github.com/octocat/private-infra/blob/main/internal/secrets/keys.ts",
			},
		]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One matching source file in a private repository.",
		});

		const result = await runReposTool(
			"user-1",
			{ action: "search_code", query: "apiKey" },
			CLOUD_MODEL_ID,
		);

		const serialized = JSON.stringify(result.modelPayload);
		expect(serialized).not.toContain("octocat/private-infra");
		expect(serialized).not.toContain("internal/secrets/keys.ts");
	});

	it("list_repos is not gated (bare repo names, like media.ts's library section names)", async () => {
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
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);

		const result = await runReposTool(
			"user-1",
			{ action: "list_repos" },
			CLOUD_MODEL_ID,
		);

		expect(result.modelPayload.repos).toEqual([
			expect.objectContaining({ fullName: "octocat/alfyai" }),
		]);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});
});
