import type {
	MemoryAction,
	MemoryDetail,
	MemoryOperation,
	MemoryPage,
	MemoryQuarantine,
	MemoryQuarantineRequest,
	MemoryRef,
	MemoryScope,
} from "$lib/memory-types";
import { type FetchLike, requestJson } from "./http";

function scopeParams(scope: MemoryScope): URLSearchParams {
	const params = new URLSearchParams({ scope: scope.kind });
	if (scope.kind === "project") params.set("projectId", scope.projectId);
	return params;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
function validScope(value: unknown): boolean {
	return (
		record(value) &&
		(value.kind === "personal" ||
			(value.kind === "project" && typeof value.projectId === "string"))
	);
}
function validRef(value: unknown): boolean {
	return (
		record(value) &&
		validScope(value.scope) &&
		typeof value.generation === "string" &&
		typeof value.rowId === "string"
	);
}
function validRow(value: unknown): boolean {
	return (
		record(value) &&
		validRef(value.ref) &&
		typeof value.text === "string" &&
		nullableString(value.updatedAt) &&
		typeof value.sourceCount === "number"
	);
}
function nullableString(value: unknown): boolean {
	return value === null || typeof value === "string";
}
function validSource(value: unknown): boolean {
	return (
		record(value) &&
		typeof value.id === "string" &&
		nullableString(value.conversationId) &&
		nullableString(value.messageId) &&
		typeof value.title === "string" &&
		typeof value.quote === "string" &&
		typeof value.assertedAt === "string" &&
		typeof value.available === "boolean"
	);
}
function validate<T>(
	value: unknown,
	check: (value: Record<string, unknown>) => boolean,
): T {
	if (!record(value) || !check(value))
		throw new Error("Invalid memory response");
	return value as T;
}
export async function fetchMemoryPage(
	options: { scope: MemoryScope; query?: string; cursor?: string },
	signal?: AbortSignal,
	fetcher?: FetchLike,
): Promise<MemoryPage> {
	const params = scopeParams(options.scope);
	if (options.query) params.set("query", options.query);
	if (options.cursor) params.set("cursor", options.cursor);
	const result = await requestJson<unknown>(
		`/api/knowledge/memory?${params}`,
		{ signal },
		"Unable to load memory",
		fetcher,
	);
	return validate<MemoryPage>(
		result,
		(v) =>
			Array.isArray(v.rows) &&
			v.rows.every(validRow) &&
			validScope(v.scope) &&
			["legacy", "preparing", "hindsight"].includes(String(v.authority)) &&
			typeof v.generation === "string" &&
			typeof v.total === "number" &&
			["ready", "queued", "working", "failed", "off"].includes(
				String(v.status),
			) &&
			(v.nextCursor === null || typeof v.nextCursor === "string"),
	);
}
export async function fetchMemoryDetail(
	ref: MemoryRef,
	signal?: AbortSignal,
	fetcher?: FetchLike,
): Promise<MemoryDetail> {
	const params = scopeParams(ref.scope);
	params.set("generation", ref.generation);
	const result = await requestJson<unknown>(
		`/api/knowledge/memory/${encodeURIComponent(ref.rowId)}?${params}`,
		{ signal },
		"Unable to load memory",
		fetcher,
	);
	return validate<MemoryDetail>(
		result,
		(v) =>
			validRow(v.row) &&
			Array.isArray(v.sources) &&
			v.sources.every(validSource) &&
			Array.isArray(v.versions) &&
			v.versions.every(
				(item) =>
					record(item) &&
					typeof item.text === "string" &&
					typeof item.changedAt === "string",
			) &&
			typeof v.canEdit === "boolean" &&
			typeof v.canRemove === "boolean",
	);
}
function operation(value: unknown): MemoryOperation {
	return validate<MemoryOperation>(
		value,
		(v) =>
			typeof v.id === "string" &&
			["queued", "working", "applied", "failed", "stale"].includes(
				String(v.status),
			) &&
			typeof v.exclusionAcknowledged === "boolean" &&
			typeof v.retryable === "boolean" &&
			typeof v.cleanupPending === "boolean" &&
			nullableString(v.errorCode) &&
			(v.ref === null || validRef(v.ref)),
	);
}
export async function submitMemoryAction(
	action: MemoryAction,
	signal?: AbortSignal,
	fetcher?: FetchLike,
): Promise<MemoryOperation> {
	return operation(
		await requestJson<unknown>(
			"/api/knowledge/memory/actions",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(action),
				signal,
			},
			"Unable to update memory",
			fetcher,
		),
	);
}
export async function fetchMemoryOperation(
	id: string,
	signal?: AbortSignal,
): Promise<MemoryOperation> {
	return operation(
		await requestJson<unknown>(
			`/api/knowledge/memory/operations/${encodeURIComponent(id)}`,
			{ signal },
			"Unable to check memory update",
		),
	);
}

export async function fetchMemoryOperationByRequest(
	requestId: string,
): Promise<MemoryOperation> {
	return operation(
		await requestJson<unknown>(
			`/api/knowledge/memory/operations?${new URLSearchParams({ requestId })}`,
			undefined,
			"Unable to check memory update",
		),
	);
}

const quarantinePath = "/api/knowledge/memory/quarantine";
function quarantine(value: unknown): MemoryQuarantine {
	return validate<MemoryQuarantine>(
		value,
		(v) =>
			[
				"unavailable",
				"idle",
				"working",
				"pending",
				"complete",
				"held",
			].includes(String(v.status)) &&
			(v.approvals === undefined ||
				(Array.isArray(v.approvals) &&
					v.approvals.every(
						(approval) =>
							record(approval) &&
							typeof approval.id === "string" &&
							typeof approval.text === "string" &&
							["queued", "failed", "succeeded"].includes(
								String(approval.status),
							) &&
							typeof approval.retryable === "boolean",
					))) &&
			Array.isArray(v.candidates) &&
			v.candidates.every((candidate) => {
				if (!record(candidate) || !record(candidate.source)) return false;
				return (
					typeof candidate.id === "string" &&
					typeof candidate.text === "string" &&
					validScope(candidate.scope) &&
					typeof candidate.source.conversationId === "string" &&
					typeof candidate.source.messageId === "string" &&
					typeof candidate.source.assertedAt === "string" &&
					Number.isFinite(Date.parse(candidate.source.assertedAt))
				);
			}),
	);
}

export async function fetchMemoryQuarantine(
	signal?: AbortSignal,
): Promise<MemoryQuarantine> {
	return quarantine(
		await requestJson<unknown>(
			quarantinePath,
			{ signal },
			"Unable to load Memory review",
		),
	);
}

export async function saveMemoryQuarantine(
	request: MemoryQuarantineRequest,
): Promise<MemoryQuarantine> {
	return quarantine(
		await requestJson<unknown>(
			quarantinePath,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request),
			},
			"Unable to save Memory review",
		),
	);
}
