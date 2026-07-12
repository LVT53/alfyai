import { z } from "zod";
import { withCapabilityConnection } from "$lib/server/services/connections/capability-read";
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
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import type { ToolEvidenceCandidate } from "$lib/types";

import { applyLocalDistillGate } from "./connector-distill";

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

const GITHUB_COM_API_ROOT = "https://api.github.com";

// The read_file citation needs a *web* URL (a blob view a human can open),
// but a connection only ever stores the *API* root (`conn.config.baseUrl` —
// see github.ts's doc comment: defaults to api.github.com, or a caller-
// supplied Gitea/GHE-compatible API root). For the default GitHub.com case
// that's simply the `api.` subdomain stripped. For self-hosted GitHub
// Enterprise Server and Gitea, the documented convention is that the API
// root lives at `<web origin>/api/v3` (GHE) or `<web origin>/api/v1` (Gitea)
// — same host as the web UI, so stripping that path suffix recovers the web
// origin in both cases. Anything else falls back to the API root's own
// origin as a best-effort web base rather than omitting the citation link
// entirely.
function reposWebBaseUrl(conn: ConnectionPublic): string {
	const raw =
		typeof conn.config.baseUrl === "string" ? conn.config.baseUrl.trim() : "";
	if (!raw || raw === GITHUB_COM_API_ROOT) return "https://github.com";

	let origin: URL;
	try {
		origin = new URL(raw);
	} catch {
		return "https://github.com";
	}

	const pathWithoutApiSuffix = origin.pathname.replace(/\/api\/v\d+\/?$/, "");
	if (pathWithoutApiSuffix !== origin.pathname) {
		const dir = pathWithoutApiSuffix === "/" ? "" : pathWithoutApiSuffix;
		return `${origin.protocol}//${origin.host}${dir}`;
	}

	if (origin.hostname.startsWith("api.")) {
		return `${origin.protocol}//${origin.hostname.slice(4)}${
			origin.port ? `:${origin.port}` : ""
		}`;
	}

	return `${origin.protocol}//${origin.host}`;
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
	const url = `${reposWebBaseUrl(conn)}/${owner}/${repo}/blob/HEAD/${path}`;
	const message = `Read ${path} from ${owner}/${repo}.`;
	return buildPayload({
		success: true,
		action: "read_file",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		file,
		citations: [{ label: path, url }],
	});
}

const REDACTED = "(redacted for privacy)";
const WITHHELD_SUFFIX =
	"couldn't be privately summarized for a cloud model, so it was withheld. Switch to a local model to view it, or try again.";

function withDistillOutcome(
	outcome: ReposToolOutcome,
	message: string,
	redacted: Partial<ReposToolModelPayload>,
): ReposToolOutcome {
	return {
		...outcome,
		modelPayload: {
			...outcome.modelPayload,
			...redacted,
			message,
		},
	};
}

// The distilled-summary message shared by every repos read branch's
// onDistilled callback — identical wording to the other connector tools.
function distilledMessage(
	outcome: ReposToolOutcome,
	distilled: string,
): string {
	return `${outcome.modelPayload.message} Privately summarized for a cloud model. Summary: ${distilled}`;
}

// Locality Option A: repos is the last connector tool (Task 7 review finding
// 1) to wire the shared decideLocalDistill gate — every other connector tool
// (contacts/media/files/photos/email/location/calendar) already refuses to
// let raw connector content reach a cloud model when the user has opted in
// to local distillation. Each read-only action that can carry raw GitHub
// content is gated on its own most-sensitive field(s):
//   - read_file: `file.content` — raw source, the most sensitive of all.
//   - list_issues/list_prs: issue/PR titles.
//   - list_commits: commit messages.
//   - search_code: repository/path text (may itself name a private repo).
// `list_repos` (bare repo names) and `ci_status` (workflow run status) are
// NOT gated — same rationale as media.ts's `libraries` (bare section names):
// structural metadata, not raw content a connector produced. As with every
// other tool's gate, `outcome.candidates` (the user's own Sources-tab list,
// built from the original unredacted data before this gate ever runs) is
// left untouched — it's the user's own data on their own screen, a
// different channel from what reaches the (cloud) model. Citation labels
// ARE redacted here (unlike files.ts, which never embeds file content in a
// citation label) because issue/PR/commit/code-search citation labels are
// built directly from the same title/message/path text being stripped —
// leaving them alone would leak the raw text back through a side channel.
function distillReposReadOutcome(params: {
	userId: string;
	modelId: string;
	input: ReposToolInput;
	outcome: ReposToolOutcome;
}): Promise<ReposToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	const payload = outcome.modelPayload;

	if (payload.action === "read_file") {
		const file =
			payload.file && payload.file.type === "file" && payload.file.content
				? payload.file
				: null;
		return applyLocalDistillGate({
			outcome,
			userId,
			modelId,
			capability: "repos",
			userQuestion: input.path ?? "",
			rawText: file?.content ?? "",
			onDistilled: (o, distilled) =>
				withDistillOutcome(o, distilledMessage(o, distilled), {
					file: file ? { ...file, content: "" } : o.modelPayload.file,
				}),
			onUnavailable: (o) =>
				withDistillOutcome(o, `This file's content ${WITHHELD_SUFFIX}`, {
					file: file ? { ...file, content: "" } : o.modelPayload.file,
				}),
		});
	}

	if (payload.action === "list_issues") {
		const redactedIssues = () =>
			payload.issues.map((issue) => ({ ...issue, title: REDACTED }));
		const patch = () => {
			const issues = redactedIssues();
			return {
				issues,
				citations: issues.map((issue) => ({
					label: `#${issue.number} ${issue.title}`,
					url: issue.url,
				})),
			};
		};
		return applyLocalDistillGate({
			outcome,
			userId,
			modelId,
			capability: "repos",
			userQuestion: input.query ?? "",
			rawText: payload.issues
				.map((issue) => `#${issue.number} ${issue.title}`)
				.join("\n"),
			onDistilled: (o, distilled) =>
				withDistillOutcome(o, distilledMessage(o, distilled), patch()),
			onUnavailable: (o) =>
				withDistillOutcome(o, `These issue titles ${WITHHELD_SUFFIX}`, patch()),
		});
	}

	if (payload.action === "list_prs") {
		const patch = () => {
			const prs = payload.prs.map((pr) => ({ ...pr, title: REDACTED }));
			return {
				prs,
				citations: prs.map((pr) => ({
					label: `#${pr.number} ${pr.title}`,
					url: pr.url,
				})),
			};
		};
		return applyLocalDistillGate({
			outcome,
			userId,
			modelId,
			capability: "repos",
			userQuestion: input.query ?? "",
			rawText: payload.prs.map((pr) => `#${pr.number} ${pr.title}`).join("\n"),
			onDistilled: (o, distilled) =>
				withDistillOutcome(o, distilledMessage(o, distilled), patch()),
			onUnavailable: (o) =>
				withDistillOutcome(
					o,
					`These pull request titles ${WITHHELD_SUFFIX}`,
					patch(),
				),
		});
	}

	if (payload.action === "list_commits") {
		const patch = () => {
			const commits = payload.commits.map((commit) => ({
				...commit,
				message: REDACTED,
			}));
			return {
				commits,
				citations: commits.map((commit) => ({
					label: commit.message.split("\n")[0] || commit.sha.slice(0, 7),
					url: commit.url,
				})),
			};
		};
		return applyLocalDistillGate({
			outcome,
			userId,
			modelId,
			capability: "repos",
			userQuestion: input.query ?? "",
			rawText: payload.commits.map((commit) => commit.message).join("\n"),
			onDistilled: (o, distilled) =>
				withDistillOutcome(o, distilledMessage(o, distilled), patch()),
			onUnavailable: (o) =>
				withDistillOutcome(
					o,
					`These commit messages ${WITHHELD_SUFFIX}`,
					patch(),
				),
		});
	}

	if (payload.action === "search_code") {
		// `url` embeds the same repository/path text being redacted (a GitHub
		// blob URL is literally `.../<repo>/blob/<ref>/<path>`), so it must be
		// blanked too — otherwise it's a side channel that leaks the very text
		// `repository`/`path` just stripped.
		const patch = () => {
			const codeResults = payload.codeResults.map((item) => ({
				...item,
				repository: REDACTED,
				path: REDACTED,
				url: "",
			}));
			return {
				codeResults,
				citations: codeResults.map((item) => ({
					label: `${item.repository} — ${item.path}`,
					url: item.url,
				})),
			};
		};
		return applyLocalDistillGate({
			outcome,
			userId,
			modelId,
			capability: "repos",
			userQuestion: input.query ?? "",
			rawText: payload.codeResults
				.map((item) => `${item.repository} — ${item.path}`)
				.join("\n"),
			onDistilled: (o, distilled) =>
				withDistillOutcome(o, distilledMessage(o, distilled), patch()),
			onUnavailable: (o) =>
				withDistillOutcome(
					o,
					`These code search results ${WITHHELD_SUFFIX}`,
					patch(),
				),
		});
	}

	// list_repos, ci_status — not gated, see the doc comment above.
	return Promise.resolve(outcome);
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
	modelId: string,
): Promise<ReposToolOutcome> {
	const notConnectedMessage =
		"You don't have a Repositories connection set up yet. Connect your GitHub account in Settings to browse repos, issues, PRs, commits, and CI.";

	// repos is single-provider (GitHub) and has no `account` selector — the seam
	// still fits: with no account, it resolves, falls back to
	// pickDefaultConnection (== connections[0] for a read), and surfaces the
	// same `ambiguous` flag this tool already used. The no-match branch is
	// simply never reached (no account is ever passed).
	const result = await withCapabilityConnection(
		userId,
		"repos",
		{},
		async (conn, { ambiguous, connections }): Promise<ReposToolOutcome> => {
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
					const outcome = codeSearchOutcome(
						conn,
						input.query,
						items,
						ambiguous,
						connections,
					);
					return distillReposReadOutcome({ userId, modelId, input, outcome });
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
					const outcome = fileOutcome(
						conn,
						input.owner,
						input.repo,
						input.path,
						file,
						ambiguous,
						connections,
					);
					return distillReposReadOutcome({ userId, modelId, input, outcome });
				}

				if (input.action === "list_issues") {
					const issues = await githubListIssues(userId, conn.id, {
						owner: input.owner,
						repo: input.repo,
						...(input.state ? { state: input.state } : {}),
						...(input.limit !== undefined ? { limit: input.limit } : {}),
					});
					const outcome = issuesOutcome(
						conn,
						input.owner,
						input.repo,
						issues,
						ambiguous,
						connections,
					);
					return distillReposReadOutcome({ userId, modelId, input, outcome });
				}

				if (input.action === "list_prs") {
					const prs = await githubListPullRequests(userId, conn.id, {
						owner: input.owner,
						repo: input.repo,
						...(input.state ? { state: input.state } : {}),
						...(input.limit !== undefined ? { limit: input.limit } : {}),
					});
					const outcome = prsOutcome(
						conn,
						input.owner,
						input.repo,
						prs,
						ambiguous,
						connections,
					);
					return distillReposReadOutcome({ userId, modelId, input, outcome });
				}

				if (input.action === "list_commits") {
					const commits = await githubListCommits(userId, conn.id, {
						owner: input.owner,
						repo: input.repo,
						...(input.path ? { path: input.path } : {}),
						...(input.limit !== undefined ? { limit: input.limit } : {}),
					});
					const outcome = commitsOutcome(
						conn,
						input.owner,
						input.repo,
						commits,
						ambiguous,
						connections,
					);
					return distillReposReadOutcome({ userId, modelId, input, outcome });
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
		},
	);

	if (result.kind === "not-connected") {
		return buildPayload({
			success: false,
			action: input.action,
			message: notConnectedMessage,
		});
	}
	// no-match is unreachable (repos has no account selector), but map it to the
	// same not-connected message for exhaustiveness rather than leaving a gap.
	if (result.kind === "no-match") {
		return buildPayload({
			success: false,
			action: input.action,
			message: notConnectedMessage,
		});
	}
	return result.value;
}
