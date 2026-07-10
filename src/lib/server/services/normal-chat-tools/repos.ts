import { z } from "zod";
import {
	type GitHubCiRunSummary,
	type GitHubCodeSearchItem,
	type GitHubCommitSummary,
	type GitHubContentResult,
	GitHubError,
	type GitHubIssueSummary,
	type GitHubPullRequestSummary,
	type GitHubRepoSummary,
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
import type { ToolEvidenceCandidate } from "$lib/types";

// Read-only by construction: this schema's `action` enum only ever lists
// read actions. GitHub NEVER gets a write path in this connector — there is
// no create_issue/comment/merge/push action here, not now and not in a
// later phase without a dedicated, explicitly confirm-gated follow-up (the
// same posture Plex's media.ts pins for its own action enum).
export const reposToolInputSchema = z.object({
	action: z.enum([
		"list_repos",
		"read_file",
		"list_issues",
		"list_prs",
		"list_commits",
		"ci_status",
		"search_code",
	]),
	owner: z.string().optional(),
	repo: z.string().optional(),
	path: z.string().optional(),
	query: z.string().optional(),
	state: z.enum(["open", "closed", "all"]).optional(),
	ref: z.string().optional(),
	limit: z.number().optional(),
});

export type ReposToolInput = z.infer<typeof reposToolInputSchema>;

export function sanitizeReposToolInput(input: ReposToolInput): ReposToolInput {
	return {
		action: input.action,
		...(input.owner ? { owner: input.owner.trim() } : {}),
		...(input.repo ? { repo: input.repo.trim() } : {}),
		...(input.path ? { path: input.path.trim() } : {}),
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.state ? { state: input.state } : {}),
		...(input.ref ? { ref: input.ref.trim() } : {}),
		...(input.limit !== undefined ? { limit: input.limit } : {}),
	};
}

export type ReposCitation = { label: string; url: string };

export type ReposToolModelPayload = {
	success: boolean;
	name: "repos";
	sourceType: "tool";
	action: ReposToolInput["action"];
	message: string;
	repos: GitHubRepoSummary[];
	issues: GitHubIssueSummary[];
	prs: GitHubPullRequestSummary[];
	commits: GitHubCommitSummary[];
	ciRuns: GitHubCiRunSummary[];
	codeResults: GitHubCodeSearchItem[];
	file?: GitHubContentResult;
	citations: ReposCitation[];
};

export type ReposToolOutcome = {
	modelPayload: ReposToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

function toCandidate(citation: ReposCitation): ToolEvidenceCandidate {
	return {
		id: `repos:${citation.url || citation.label}`,
		title: citation.label,
		url: citation.url,
		snippet: citation.label,
		sourceType: "tool",
	};
}

function buildPayload(params: {
	success: boolean;
	action: ReposToolInput["action"];
	message: string;
	repos?: GitHubRepoSummary[];
	issues?: GitHubIssueSummary[];
	prs?: GitHubPullRequestSummary[];
	commits?: GitHubCommitSummary[];
	ciRuns?: GitHubCiRunSummary[];
	codeResults?: GitHubCodeSearchItem[];
	file?: GitHubContentResult;
	citations?: ReposCitation[];
}): ReposToolOutcome {
	const citations = params.citations ?? [];
	return {
		modelPayload: {
			success: params.success,
			name: "repos",
			sourceType: "tool",
			action: params.action,
			message: params.message,
			repos: params.repos ?? [],
			issues: params.issues ?? [],
			prs: params.prs ?? [],
			commits: params.commits ?? [],
			ciRuns: params.ciRuns ?? [],
			codeResults: params.codeResults ?? [],
			...(params.file ? { file: params.file } : {}),
			citations,
		},
		candidates: citations.map(toCandidate),
	};
}

function ambiguityNote(
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	const labels = connections.map((c) => c.label).join(", ");
	return `You have ${connections.length} Repositories connections (${labels}); using "${conn.label}" for this request.`;
}

function withAmbiguityPrefix(
	message: string,
	ambiguous: boolean,
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	return ambiguous ? `${ambiguityNote(conn, connections)} ${message}` : message;
}

function mapAdapterError(err: unknown): string {
	if (err instanceof GitHubError) {
		switch (err.code) {
			case "needs_reauth":
				return "Your GitHub connection needs to be reconnected before I can access your repositories. Please reconnect it in Settings.";
			case "connection_not_found":
				return "Your GitHub connection couldn't be found. Please reconnect it in Settings.";
			case "not_found":
				return "That repository, path, or resource couldn't be found.";
			default:
				return "I couldn't reach GitHub right now. Please try again in a moment.";
		}
	}
	return "I couldn't reach GitHub right now. Please try again in a moment.";
}

function missingParamOutcome(
	action: ReposToolInput["action"],
	message: string,
): ReposToolOutcome {
	return buildPayload({ success: false, action, message });
}

function reposOutcome(
	conn: ConnectionPublic,
	repos: GitHubRepoSummary[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): ReposToolOutcome {
	const citations: ReposCitation[] = repos.map((repo) => ({
		label: repo.fullName,
		url: repo.url,
	}));
	const message =
		repos.length === 0
			? "No repositories found."
			: `Found ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}.`;
	return buildPayload({
		success: true,
		action: "list_repos",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		repos,
		citations,
	});
}

function issuesOutcome(
	conn: ConnectionPublic,
	owner: string,
	repo: string,
	issues: GitHubIssueSummary[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): ReposToolOutcome {
	const citations: ReposCitation[] = issues.map((issue) => ({
		label: `#${issue.number} ${issue.title}`,
		url: issue.url,
	}));
	const message =
		issues.length === 0
			? `No issues found in ${owner}/${repo}.`
			: `Found ${issues.length} ${issues.length === 1 ? "issue" : "issues"} in ${owner}/${repo}.`;
	return buildPayload({
		success: true,
		action: "list_issues",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		issues,
		citations,
	});
}

function prsOutcome(
	conn: ConnectionPublic,
	owner: string,
	repo: string,
	prs: GitHubPullRequestSummary[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): ReposToolOutcome {
	const citations: ReposCitation[] = prs.map((pr) => ({
		label: `#${pr.number} ${pr.title}`,
		url: pr.url,
	}));
	const message =
		prs.length === 0
			? `No pull requests found in ${owner}/${repo}.`
			: `Found ${prs.length} pull ${prs.length === 1 ? "request" : "requests"} in ${owner}/${repo}.`;
	return buildPayload({
		success: true,
		action: "list_prs",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		prs,
		citations,
	});
}

function commitsOutcome(
	conn: ConnectionPublic,
	owner: string,
	repo: string,
	commits: GitHubCommitSummary[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): ReposToolOutcome {
	const citations: ReposCitation[] = commits.map((commit) => ({
		label: commit.message.split("\n")[0] || commit.sha.slice(0, 7),
		url: commit.url,
	}));
	const message =
		commits.length === 0
			? `No commits found in ${owner}/${repo}.`
			: `Found ${commits.length} ${commits.length === 1 ? "commit" : "commits"} in ${owner}/${repo}.`;
	return buildPayload({
		success: true,
		action: "list_commits",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		commits,
		citations,
	});
}

function ciStatusOutcome(
	conn: ConnectionPublic,
	owner: string,
	repo: string,
	runs: GitHubCiRunSummary[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): ReposToolOutcome {
	const citations: ReposCitation[] = runs.map((run) => ({
		label: `${run.name ?? "Workflow run"} — ${run.conclusion ?? run.status}`,
		url: run.url,
	}));
	const message =
		runs.length === 0
			? `No CI runs found in ${owner}/${repo}.`
			: `Found ${runs.length} CI ${runs.length === 1 ? "run" : "runs"} in ${owner}/${repo}.`;
	return buildPayload({
		success: true,
		action: "ci_status",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		ciRuns: runs,
		citations,
	});
}

function codeSearchOutcome(
	conn: ConnectionPublic,
	query: string,
	items: GitHubCodeSearchItem[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): ReposToolOutcome {
	const citations: ReposCitation[] = items.map((item) => ({
		label: `${item.repository} — ${item.path}`,
		url: item.url,
	}));
	const message =
		items.length === 0
			? `No code matches found for "${query}".`
			: `Found ${items.length} code ${items.length === 1 ? "match" : "matches"} for "${query}".`;
	return buildPayload({
		success: true,
		action: "search_code",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		codeResults: items,
		citations,
	});
}

function fileOutcome(
	conn: ConnectionPublic,
	owner: string,
	repo: string,
	path: string,
	file: GitHubContentResult,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): ReposToolOutcome {
	if (file.type === "dir") {
		const message = `"${path}" is a directory with ${file.entries.length} ${file.entries.length === 1 ? "entry" : "entries"}. Use the entry names/paths to read a specific file.`;
		return buildPayload({
			success: true,
			action: "read_file",
			message: withAmbiguityPrefix(message, ambiguous, conn, connections),
			file,
		});
	}
	const url = `https://github.com/${owner}/${repo}/blob/HEAD/${path}`;
	const message = `Read ${path} from ${owner}/${repo}.`;
	return buildPayload({
		success: true,
		action: "read_file",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		file,
		citations: [{ label: path, url }],
	});
}

// Resolves the user's Repositories (GitHub) connection(s) and executes the
// requested read-only action, degrading gracefully (never throwing) so a
// connection problem never aborts the chat turn: no connection, ambiguity,
// missing required params, and adapter failures all resolve to a
// `{ success: false, message }`-shaped payload instead. Read-only, and
// permanently so for v1 — see reposToolInputSchema's doc comment.
export async function runReposTool(
	userId: string,
	input: ReposToolInput,
): Promise<ReposToolOutcome> {
	const connections = await resolveConnectionsForCapability(userId, "repos");
	if (connections.length === 0) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Repositories connection set up yet. Connect your GitHub account in Settings to browse repos, issues, PRs, commits, and CI.",
		});
	}

	const ambiguous = needsDisambiguation(connections);
	const conn = connections[0];
	if (!conn) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Repositories connection set up yet. Connect your GitHub account in Settings to browse repos, issues, PRs, commits, and CI.",
		});
	}

	try {
		if (input.action === "list_repos") {
			const repos = await githubListRepos(userId, conn.id, {
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			});
			return reposOutcome(conn, repos, ambiguous, connections);
		}

		if (input.action === "search_code") {
			if (!input.query) {
				return missingParamOutcome(
					"search_code",
					"A search query is required to search code.",
				);
			}
			const items = await githubSearchCode(userId, conn.id, {
				query: input.query,
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			});
			return codeSearchOutcome(
				conn,
				input.query,
				items,
				ambiguous,
				connections,
			);
		}

		// Every remaining action is scoped to one repository.
		if (!input.owner || !input.repo) {
			return missingParamOutcome(
				input.action,
				"An `owner` and `repo` are required for this action.",
			);
		}

		if (input.action === "read_file") {
			if (!input.path) {
				return missingParamOutcome(
					"read_file",
					"A `path` is required to read a file.",
				);
			}
			const file = await githubReadFile(userId, conn.id, {
				owner: input.owner,
				repo: input.repo,
				path: input.path,
				...(input.ref ? { ref: input.ref } : {}),
			});
			return fileOutcome(
				conn,
				input.owner,
				input.repo,
				input.path,
				file,
				ambiguous,
				connections,
			);
		}

		if (input.action === "list_issues") {
			const issues = await githubListIssues(userId, conn.id, {
				owner: input.owner,
				repo: input.repo,
				...(input.state ? { state: input.state } : {}),
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			});
			return issuesOutcome(
				conn,
				input.owner,
				input.repo,
				issues,
				ambiguous,
				connections,
			);
		}

		if (input.action === "list_prs") {
			const prs = await githubListPullRequests(userId, conn.id, {
				owner: input.owner,
				repo: input.repo,
				...(input.state ? { state: input.state } : {}),
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			});
			return prsOutcome(
				conn,
				input.owner,
				input.repo,
				prs,
				ambiguous,
				connections,
			);
		}

		if (input.action === "list_commits") {
			const commits = await githubListCommits(userId, conn.id, {
				owner: input.owner,
				repo: input.repo,
				...(input.path ? { path: input.path } : {}),
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			});
			return commitsOutcome(
				conn,
				input.owner,
				input.repo,
				commits,
				ambiguous,
				connections,
			);
		}

		// ci_status
		const runs = await githubCiStatus(userId, conn.id, {
			owner: input.owner,
			repo: input.repo,
			...(input.ref ? { ref: input.ref } : {}),
			...(input.limit !== undefined ? { limit: input.limit } : {}),
		});
		return ciStatusOutcome(
			conn,
			input.owner,
			input.repo,
			runs,
			ambiguous,
			connections,
		);
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
