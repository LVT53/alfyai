#!/usr/bin/env node
/** Node 22. Authoring is offline; --execute is required for staging HTTP/model work.
 * EMAIL/PASSWORD/BASE/APP_ORIGIN are read only by main after --execute validation.
 * One dedicated synthetic account, serial calls, exact generated IDs, no SQL execution.
 * --plan prints the synthetic matrix without login. --inspect REPORT --audit-json AUDIT
 * verifies externally obtained, ID-scoped rows; AUDIT is {turns:[],attempts:[]}.
 * Ordinary results fail closed on wrong answers, missing structural completion,
 * missing tools, model substitution or persistence disagreement. Forced SDK exits
 * and buffer exhaustion belong to deterministic integration tests, not this live probe.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Historical staging IDs from staging-results-2026-11-10.json. Fail if no longer listed.
export const MODEL_MATRIX = Object.freeze({
	deepseek: "provider:68d77707-6ace-4e55-8eee-a8ff49e7fec3:5b03df4e-1144-465e-ab7e-d8a40f8c70c6",
	kimi: "provider:901b7294-cf08-441b-a8e0-46494bc28145:7a511b91-39bf-4f58-8eb3-aa9500c19b05",
	qwen: "provider:7107c713-f6ff-483b-aba3-72556d569949:c45389f7-2daa-4911-8da9-b679f7657089",
});
// Deliberately no substitution in this acceptance matrix, even if the app permits fallback.
const MODEL_NAMES = Object.freeze({
	deepseek: "deepseek-flash",
	kimi: "accounts/fireworks/models/kimi-k3p1-pro",
	qwen: "qwen3-6-27b",
});
const need = (condition, message) => {
	if (!condition) throw new Error(message);
};
const normalize = (text) =>
	String(text ?? "")
		.replace(/\r\n/g, "\n")
		.trim();

const STAGE_BASE = "https://ai.dev.alfydesign.com";
class SetupFailure extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}
class ApiFailure extends Error {
	constructor(path, status) {
		super(`API refused ${path.split("?")[0]} HTTP ${status}`);
		this.status = status;
	}
}
const exactKeys = (value, keys) =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.keys(value).length === keys.length &&
	keys.every((key) => Object.hasOwn(value, key));
export function parseModelMetadata(bytes, families) {
	try {
		const value = JSON.parse(bytes);
		need(
			exactKeys(value, ["version", "source", "base", "models"]) &&
				value.version === 1 &&
				value.source === "stage-db-readonly" &&
				value.base === STAGE_BASE &&
				Array.isArray(value.models) &&
				value.models.length > 0,
			"invalid",
		);
		const seen = new Set();
		for (const row of value.models) {
			need(
				exactKeys(row, ["providerId", "modelId", "name"]) &&
					[row.providerId, row.modelId, row.name].every((value) => typeof value === "string"),
				"invalid",
			);
			const id = `provider:${row.providerId}:${row.modelId}`;
			const family = Object.keys(MODEL_MATRIX).find((key) => MODEL_MATRIX[key] === id);
			need(family && row.name === MODEL_NAMES[family] && !seen.has(id), "invalid");
			seen.add(id);
		}
		need(
			families.every((family) => seen.has(MODEL_MATRIX[family])),
			"invalid",
		);
		return {
			models: value.models,
			provenance: {
				version: value.version,
				source: value.source,
				base: value.base,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		};
	} catch {
		throw new SetupFailure("invalid-model-metadata", "Invalid trusted stage model metadata");
	}
}
export async function verifyModelBindings(client, families, trustedMetadata, onPhase = () => {}) {
	onPhase("public-models");
	const listed = await client.json("/api/models");
	const ids = listed.providers.flatMap((p) => p.models.map((m) => m.id));
	if (!families.every((f) => ids.includes(MODEL_MATRIX[f])))
		throw new SetupFailure("selected-model-unavailable", "Selected staging model is unavailable");
	onPhase("model-bindings");
	const bindings = [];
	for (const family of families) {
		const [, providerId, modelId] = MODEL_MATRIX[family].split(":");
		const models = trustedMetadata
			? trustedMetadata.models
			: (await client.json(`/api/admin/providers/${providerId}/models`)).models;
		const matches = models.filter(
			(m) => m.id === modelId || (m.modelId === modelId && m.providerId === providerId),
		);
		if (matches.length !== 1 || matches[0].name !== MODEL_NAMES[family])
			throw new SetupFailure("model-binding-mismatch", "Staging model binding changed");
		bindings.push({ family, providerId, modelId, name: MODEL_NAMES[family] });
	}
	return {
		bindings,
		provenance: trustedMetadata?.provenance ?? { source: "admin-api", base: STAGE_BASE },
	};
}
function setupDiagnostic(phase, error) {
	const code =
		error instanceof SetupFailure
			? error.code
			: error instanceof ApiFailure && phase === "model-bindings"
				? "admin-metadata-unavailable"
				: "setup-request-failed";
	return {
		phase,
		code,
		...(error instanceof ApiFailure ? { httpStatus: error.status } : {}),
		hint:
			phase === "model-bindings" && code === "admin-metadata-unavailable"
				? "Admin model metadata unavailable; a normal account must use --model-metadata-json with an authoritative read-only stage export."
				: phase === "metadata-file"
					? "Supply a valid stage-only export for every selected model; no admin fallback is attempted."
					: "Check this staging setup phase before retrying; no model generation was started.",
	};
}

export function assertKnownAnswer(answer, expected) {
	// Explicit output grammar requested in synthetic prompts; wrong/duplicate keys fail.
	// No linguistic classifier, visible-character score or completion enum can pass this.
	const lines = normalize(answer)
		.replace(/\*\*|`/g, "")
		.split("\n")
		.map((s) => s.trim());
	for (const [key, value] of Object.entries(expected)) {
		const found = lines.filter((line) => line.startsWith(`${key}=`));
		need(found.length === 1 && found[0] === `${key}=${value}`, `Known answer mismatch: ${key}`);
	}
}
export function assertOrdinary(result, expected, modelId, requiredTool, verifiedDelivery = false) {
	need(
		result.status === 200 && result.terminal && !result.errors?.length,
		"Ordinary transport/terminal failure",
	);
	need(result.modelId === modelId, "Actual model differs from requested staging model");
	need(
		result.completion?.outcome === "answered" || result.completion?.outcome === "delivered",
		"Ordinary turn is not answered/delivered",
	);
	need(
		normalize(result.answer) || (verifiedDelivery && result.completion.outcome === "delivered"),
		"Ordinary answer is blank without verified delivery",
	);
	if (requiredTool)
		need(
			result.tools?.some(
				(call) =>
					call.name === requiredTool && call.status === "done" && call.metadata?.ok !== false,
			),
			`Required successful tool absent: ${requiredTool}`,
		);
	if (normalize(result.answer) || !verifiedDelivery) assertKnownAnswer(result.answer, expected);
}
export function assertGuard(result) {
	need(
		result.status === 200 && result.terminal && result.completion,
		"Guard lacks explicit terminal completion",
	);
	if (!normalize(result.answer)) {
		need(
			["incomplete", "failed"].includes(result.completion.outcome),
			"Blank was falsely reported successful",
		);
		return "expected-explicit-failure";
	}
	need(result.completion.outcome === "answered", "Nonblank guard did not complete an answer");
	assertKnownAnswer(result.answer, { PRODUCT: "391" });
	return "answered-despite-quiet-request";
}

/** Independent consumer of the published v1 output events, not invented SSE names.
 * This small probe retains blocks once and ignores legacy deltas; missing new server
 * wiring fails acceptance rather than reconstructing roles with prose heuristics.
 */
export function createStreamProbe() {
	const blocks = new Map(),
		seen = new Set(),
		tools = new Map();
	let completion,
		scope,
		terminal = false,
		metadata = {},
		errors = [];
	return {
		part(part) {
			if (part === "[DONE]") {
				terminal = true;
				return;
			}
			if (part.type === "finish") terminal = true;
			if (part.type === "error" || part.type === "data-stream-error") errors.push(part.type);
			if (part.type === "data-stream-metadata") metadata = { ...metadata, ...part.data };
			if (part.type === "data-tool-call") {
				const call = part.data;
				need(typeof call?.callId === "string", "Tool event lacks stable call ID");
				tools.set(call.callId, {
					callId: call.callId,
					name: call.name,
					status: call.status,
					metadata: { ok: call.metadata?.ok },
				});
			}
			if (part.type !== "data-normal-chat-output") return;
			const event = part.data;
			need(
				event?.version === 1 &&
					typeof event.turnId === "string" &&
					typeof event.stepId === "string" &&
					typeof event.segmentId === "string" &&
					typeof event.attemptId === "string" &&
					Number.isInteger(event.sequence),
				"Unsupported structural output contract",
			);
			scope = { turnId: event.turnId, segmentId: event.segmentId };
			const key = JSON.stringify([event.turnId, event.segmentId, event.attemptId, event.sequence]);
			if (seen.has(key)) return;
			seen.add(key);
			const id = JSON.stringify([event.turnId, event.segmentId, event.attemptId, event.blockId]);
			if (event.type === "block_start") blocks.set(id, { ...event, text: "" });
			if (event.type === "block_delta") {
				need(blocks.has(id), "Output delta has no block start");
				blocks.get(id).text += event.text;
			}
			if (event.type === "step_settled")
				for (const block of blocks.values()) {
					if (
						block.segmentId === event.segmentId &&
						block.attemptId === event.attemptId &&
						block.stepId === event.stepId &&
						block.kind === "text"
					)
						block.role = event.role;
				}
			if (event.type === "completion") completion = event.completion;
		},
		result() {
			const textBlocks = [...blocks.values()].filter((b) => b.kind === "text");
			return {
				...scope,
				terminal,
				answer: textBlocks
					.filter((b) => b.role === "answer")
					.map((b) => b.text)
					.join(""),
				activity: textBlocks.filter((b) => b.role !== "answer").map((b) => b.text),
				completion,
				tools: [...tools.values()],
				modelId: metadata.modelId,
				assistantMessageId: metadata.assistantMessageId,
				waitingQuestionId: metadata.waitingQuestionId,
				errors,
				structuralEvents: seen.size,
			};
		},
	};
}
function frames(buffer) {
	const pieces = buffer.split(/\r\n\r\n|\n\n|\r\r/),
		rest = pieces.pop();
	const parts = [];
	for (const piece of pieces) {
		const lines = piece.replace(/\r\n?/g, "\n").split("\n");
		if (lines.some((l) => l.startsWith("event:"))) continue;
		const data = lines
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trimStart())
			.join("\n");
		if (!data) continue;
		parts.push(data === "[DONE]" ? data : JSON.parse(data));
	}
	return { parts, rest };
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const identityFields = [
	["segmentId", "segment_id"],
	["turnId", "turn_id"],
	["assistantMessageId", "message_id"],
];
function validateIdentity(identity) {
	need(
		typeof identity.conversationId === "string" &&
			identity.conversationId.length > 0 &&
			identityFields.some(([key]) => typeof identity[key] === "string" && identity[key].length > 0),
		"Missing exact generated turn/message identity",
	);
	for (const [key] of identityFields)
		if (identity[key] !== undefined) {
			need(
				(key === "assistantMessageId" && identity[key] === null) ||
					(typeof identity[key] === "string" && identity[key].length > 0),
				"Malformed generated identity",
			);
		}
}
function matches(row, identity) {
	return (
		row.conversation_id === identity.conversationId &&
		identityFields.every(
			([key, column]) => identity[key] === undefined || row[column] === identity[key],
		)
	);
}
function modelPolicy(identity) {
	const requested = identity.requestedModelId;
	const family = Object.keys(MODEL_MATRIX).find((key) => MODEL_MATRIX[key] === requested);
	need(family, "Audit lacks a supported requested model policy");
	need(
		identity.modelId === undefined || identity.modelId === requested,
		"Observed model differs from requested matrix identity",
	);
	return { modelId: requested, providerId: requested.split(":")[1], name: MODEL_NAMES[family] };
}
export function buildAuditSql(identities) {
	need(identities.length, "No generated identities to audit");
	const clauses = identities
		.map((id) => {
			validateIdentity(id);
			const predicates = [`t.conversation_id=${quote(id.conversationId)}`];
			for (const [key, column] of identityFields)
				if (id[key] !== undefined) {
					predicates.push(
						id[key] === null ? `t.${column} IS NULL` : `t.${column}=${quote(id[key])}`,
					);
				}
			return `(${predicates.join(" AND ")})`;
		})
		.join(" OR ");
	// Content-free, SELECT only, no broad conversation scan and no owner data columns.
	return `-- Run read-only against staging only; capture each SELECT as JSON.\nSELECT t.segment_id,t.turn_id,t.conversation_id,t.message_id,t.phase,t.outcome,t.stop_cause,t.working_stop_cause,t.closing_attempted,t.attempt_ids_json,t.accounting_status FROM normal_chat_turns t WHERE ${clauses};\nSELECT a.attempt_id,a.segment_id,a.phase,a.provider_id,a.model_id,a.provider_model_name,a.safe_stop_cause,a.outcome,a.input_tokens,a.output_tokens,a.total_tokens,a.usage_final,a.cost_usd_micros FROM normal_chat_attempts a JOIN normal_chat_turns t ON t.segment_id=a.segment_id WHERE ${clauses};\n`;
}
export function inspectAudit(audit, identities) {
	need(
		Array.isArray(audit.turns) && Array.isArray(audit.attempts),
		"Audit must contain turns and attempts arrays",
	);
	need(identities.length, "No generated identities to audit");
	for (const identity of identities) {
		validateIdentity(identity);
		modelPolicy(identity);
	}
	const segments = new Set(),
		attempts = new Map();
	for (const row of audit.attempts) {
		need(!attempts.has(row.attempt_id), "Duplicate durable attempt");
		attempts.set(row.attempt_id, row);
	}
	let total = 0;
	for (const row of audit.turns) {
		need(
			identities.some((id) => matches(row, id)),
			"Audit contains data outside generated IDs",
		);
		need(!segments.has(row.segment_id), "Duplicate terminal segment");
		segments.add(row.segment_id);
		need(
			row.outcome && row.accounting_status === "ready",
			"Audit outcome/accounting not terminal/ready",
		);
		const manifest = JSON.parse(row.attempt_ids_json ?? "null");
		need(
			Array.isArray(manifest) && manifest.length && new Set(manifest).size === manifest.length,
			"Missing/duplicate attempt manifest",
		);
		const children = audit.attempts.filter((a) => a.segment_id === row.segment_id);
		need(
			children.length === manifest.length &&
				manifest.every((id) => attempts.get(id)?.segment_id === row.segment_id),
			"Attempt manifest mismatch",
		);
		let segmentCost = 0;
		for (const child of children) {
			need(
				child.usage_final === 1 &&
					Number.isSafeInteger(child.cost_usd_micros) &&
					child.cost_usd_micros >= 0,
				"Unknown/unreconciled attempt usage/cost",
			);
			need(
				[child.input_tokens, child.output_tokens, child.total_tokens].every(
					(n) => Number.isSafeInteger(n) && n >= 0,
				),
				"Attempt token usage remains unknown",
			);
			need(
				!/deepseek.*pro/i.test(child.provider_model_name ?? ""),
				"Unexpected DeepSeek pro attempt",
			);
			segmentCost += child.cost_usd_micros;
		}
		for (const id of identities.filter((id) => matches(row, id))) {
			if (id.outcome) need(row.outcome === id.outcome, "Durable outcome disagrees with receipt");
			if (id.allowedOutcomes)
				need(
					id.allowedOutcomes.includes(row.outcome),
					"Plain durable outcome is not answered/delivered",
				);
			const policy = modelPolicy(id);
			need(
				children.every(
					(a) =>
						a.model_id === policy.modelId &&
						a.provider_id === policy.providerId &&
						a.provider_model_name === policy.name,
				),
				"An actual attempt provider/model/name differs from the requested matrix policy",
			);
			if (id.costUsdMicros != null)
				need(
					segmentCost === id.costUsdMicros,
					"Attempt total differs from message usage aggregate",
				);
		}
		total += segmentCost;
	}
	need(
		identities.every((id) => audit.turns.some((row) => matches(row, id))),
		"Generated turn missing from durable audit",
	);
	need(
		audit.attempts.every((a) => segments.has(a.segment_id)),
		"Unscoped attempt in audit",
	);
	return { segments: segments.size, attempts: attempts.size, costUsdMicros: total };
}
export async function runSerial(items, run, persist) {
	const report = { status: "running", results: [] };
	await persist(structuredClone(report));
	for (const item of items) {
		try {
			report.results.push(await run(item));
		} catch (error) {
			report.results.push({ failed: true, error: error.message });
			report.status = "failed";
			await persist(structuredClone(report));
			return report;
		}
		await persist(structuredClone(report));
	}
	report.status = "http-checks-passed-audit-pending";
	await persist(structuredClone(report));
	return report;
}
export function validateTarget({ base, execute }) {
	need(execute === true, "Staging execution requires --execute");
	const url = new URL(base);
	need(
		(url.protocol === "https:" &&
			url.hostname === "ai.dev.alfydesign.com" &&
			(!url.port || url.port === "443")) ||
			(["http:", "https:"].includes(url.protocol) &&
				["127.0.0.1", "localhost"].includes(url.hostname) &&
				url.port === "3002"),
		"Only the staging target/port is allowed",
	);
	need(
		!url.username && !url.password && !url.search && !url.hash && url.pathname === "/",
		"Base must be a credential-free staging origin",
	);
}

export function syntheticPlan(runId) {
	need(/^[A-Za-z0-9-]+$/.test(runId), "Invalid synthetic run ID");
	const title = `Contract evidence ${runId}`;
	const evidence = `# ${title}\n\n${Array.from({ length: 50 }, (_, i) => `Entry ${i + 1}: synthetic filing context; keep the complete record.`).join("\n")}\n\nArchive key: ORCHID-73. Dispatch is Tuesday. Crates: 19. Loose units: 23.\n`;
	return [
		{
			key: "stream-math",
			transport: "stream",
			prompt:
				"Use run_python to calculate 17*23. Then answer in English with exactly one line PRODUCT=<integer>, using the computed result.",
			expected: { PRODUCT: "391" },
			tool: "run_python",
		},
		{
			key: "plain-math",
			transport: "plain",
			prompt:
				"Use run_python to calculate 17*23. Then answer in English with exactly one line PRODUCT=<integer>, using the computed result.",
			expected: { PRODUCT: "391" },
			tool: "run_python",
		},
		{
			key: "evidence-create",
			shared: true,
			transport: "stream",
			prompt: `Create exactly one Document titled '${title}' using create_artifact. Preserve this full synthetic body verbatim, including its last sentence. Afterwards say STORED=YES.\n\n${evidence}`,
			expected: { STORED: "YES" },
			tool: "create_artifact",
			artifactTitle: title,
			evidence,
		},
		{
			key: "evidence-followup",
			shared: true,
			transport: "stream",
			prompt: `Read the complete Document '${title}' with read_artifact, not just a summary. Use run_python to add its crate and loose-unit counts. Return exactly three English lines ARCHIVE=<key>, DISPATCH=<weekday>, TOTAL=<integer>. The values must come from the Document, not guesses.`,
			expected: { ARCHIVE: "ORCHID-73", DISPATCH: "Tuesday", TOTAL: "42" },
			tool: "read_artifact",
			alsoTool: "run_python",
		},
		{
			key: "plain-followup",
			shared: true,
			transport: "plain",
			prompt: `Read '${title}' again. Return exactly three English lines ARCHIVE=<key>, DISPATCH=<weekday>, TOTAL=<crate count plus loose units>.`,
			expected: { ARCHIVE: "ORCHID-73", DISPATCH: "Tuesday", TOTAL: "42" },
			tool: "read_artifact",
		},
		{
			key: "pause-resume",
			transport: "stream",
			prompt:
				"Call ask_user to ask which calculation I want. Offer '17 times 23' as the first recommended option and '19 plus 23' second. Do not choose for me. After I answer, use run_python and return one English line PRODUCT=<result>.",
			pause: true,
		},
		{
			key: "file-delivery",
			transport: "stream",
			prompt: `Use produce_file to create a Markdown file contract-${runId}.md containing exactly '# Synthetic result\n\nPRODUCT=391\n'. Then answer FILE=READY.`,
			expected: { FILE: "READY" },
			tool: "produce_file",
			filename: `contract-${runId}.md`,
		},
		{
			key: "disconnect-observe",
			transport: "stream",
			prompt:
				"Use run_python to calculate 17*23, then return exactly PRODUCT=<integer> in English.",
			expected: { PRODUCT: "391" },
			tool: "run_python",
			reconnect: true,
		},
		{
			key: "stop-control",
			transport: "stream",
			prompt: "Use run_python to calculate 17*23. Then explain the multiplication in detail.",
			stop: true,
		},
		{
			key: "quiet-control",
			transport: "stream",
			prompt:
				"Use run_python to calculate 17*23. This synthetic test requests zero final characters: leave the final reply empty. If you must answer, return exactly PRODUCT=<integer> using the result.",
			guard: true,
		},
	];
}

export function createClient({ base, origin, fetchImpl = fetch, signal }) {
	const jar = new Map();
	async function request(path, init = {}) {
		need(path.startsWith("/api/"), "Only app API paths are allowed");
		const response = await fetchImpl(`${base}${path}`, {
			...init,
			redirect: "error",
			headers: {
				origin,
				...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...init.headers,
			},
			signal: AbortSignal.any([
				init.signal ?? AbortSignal.timeout(path === "/api/chat/send" ? 240_000 : 30_000),
				...(signal && path !== "/api/chat/stream/stop" ? [signal] : []),
			]),
		});
		for (const cookie of response.headers.getSetCookie?.() ?? []) {
			const pair = cookie.split(";")[0],
				index = pair.indexOf("=");
			if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
		}
		return response;
	}
	async function json(path, body) {
		const res = await request(
			path,
			body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
		);
		if (!res.ok) throw new ApiFailure(path, res.status);
		return res.json();
	}
	return { request, json };
}
async function consumeStream(client, path, body, { onPart, signal } = {}) {
	const res = await client.request(path, {
		method: "POST",
		body: JSON.stringify(body),
		signal: signal ?? AbortSignal.timeout(240_000),
	});
	need(res.ok && res.body, `Stream refused HTTP ${res.status}`);
	const probe = createStreamProbe(),
		reader = res.body.getReader(),
		decoder = new TextDecoder();
	let rest = "";
	try {
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			const parsed = frames(rest + decoder.decode(item.value, { stream: true }));
			rest = parsed.rest;
			for (const part of parsed.parts) {
				probe.part(part);
				if (await onPart?.(part, probe.result())) {
					await reader.cancel();
					return { ...probe.result(), status: res.status, detached: true };
				}
			}
		}
		need(!normalize(rest + decoder.decode()), "Stream ended in an incomplete SSE frame");
		return { ...probe.result(), status: res.status };
	} finally {
		reader.releaseLock();
	}
}
function identify(record, result) {
	Object.assign(record, result, {
		turnId: result.completion?.turnId ?? result.turnId,
		segmentId: result.completion?.segmentId ?? result.segmentId,
		outcome: result.completion?.outcome,
	});
}
async function readUsage(client, conversationId, messageId) {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const usage = await client.json(
			`/api/conversations/${conversationId}/messages/${messageId}/usage`,
		);
		if (usage.status === "ready") return usage;
		need(
			usage.status === "pending" && Date.now() < deadline,
			"Usage aggregate did not reconcile within scoped polling bound",
		);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}
async function savedResult(client, record, beforeIds) {
	const detail = await client.json(`/api/conversations/${record.conversationId}`);
	const fresh = detail.messages.filter((m) => m.role === "assistant" && !beforeIds.has(m.id));
	if (detail.conversation?.id !== undefined)
		need(detail.conversation.id === record.conversationId, "Wrong saved conversation");
	const candidates = record.assistantMessageId
		? fresh.filter((m) => m.id === record.assistantMessageId)
		: fresh;
	const permittedIds = new Set(
		[record.assistantMessageId, record.pausedSegment?.assistantMessageId].filter(Boolean),
	);
	need(
		candidates.length === 1 &&
			(fresh.length === 1 ||
				(record.pausedSegment &&
					fresh.length === 2 &&
					fresh.every((message) => permittedIds.has(message.id)))),
		"No unique saved assistant result; ambiguous fresh rows",
	);
	const saved = candidates[0];
	need(
		saved.normalChatOutput?.version === 1 && Array.isArray(saved.normalChatOutput.events),
		"Saved result has no structural completion",
	);
	const completions = saved.normalChatOutput.events.filter(
		(event) => event.type === "completion" && event.completion?.segmentId === record.segmentId,
	);
	need(
		completions.length === 1,
		"Saved completion is missing or ambiguous for the receipt segment",
	);
	const actual = completions[0].completion;
	need(
		[
			"version",
			"turnId",
			"segmentId",
			"phase",
			"outcome",
			"stopCause",
			"workingStopCause",
			"closingAttempted",
		].every((key) => actual[key] === record.completion?.[key]),
		"Saved completion disagrees with receipt",
	);
	record.assistantMessageId = saved.id;
	return { detail, saved };
}

/** HTTP orchestration is dependency-injected for offline transport tests. */
export async function runCase(client, spec, modelId, record) {
	record.requestedModelId = modelId;
	const before = await client.json(`/api/conversations/${record.conversationId}`);
	const beforeIds = new Set(before.messages.map((m) => m.id));
	const body = {
		conversationId: record.conversationId,
		message: spec.prompt,
		streamId: record.streamId,
		model: modelId,
		reasoningDepth: "thorough",
	};
	let result;
	if (spec.transport === "plain") {
		const reply = await client.json("/api/chat/send", body);
		result = {
			status: 200,
			terminal: Boolean(reply.completion),
			answer: reply.response?.text,
			completion: reply.completion,
			warning: reply.warning,
			errors: [],
		};
		// Capture receipt IDs even when an unsaved/partial ordinary turn must fail.
		identify(record, result);
		record.auditRequired = true;
		const receipt = reply.completion;
		need(
			receipt?.version === 1 &&
				typeof receipt.turnId === "string" &&
				receipt.turnId.length > 0 &&
				typeof receipt.segmentId === "string" &&
				receipt.segmentId.length > 0 &&
				["working", "closing"].includes(receipt.phase) &&
				["answered", "delivered", "paused", "stopped", "incomplete", "failed"].includes(
					receipt.outcome,
				) &&
				typeof receipt.stopCause === "string" &&
				receipt.stopCause.length > 0 &&
				typeof receipt.workingStopCause === "string" &&
				receipt.workingStopCause.length > 0 &&
				typeof receipt.closingAttempted === "boolean",
			"Plain completion is missing or malformed",
		);
		if (["incomplete", "failed", "stopped"].includes(receipt.outcome)) {
			need(
				reply.warning?.code === "normal_chat_completion" &&
					reply.warning.outcome === receipt.outcome &&
					reply.warning.stopCause === receipt.stopCause,
				"Plain warning missing or disagrees with completion",
			);
		} else
			need(reply.warning === undefined, "Plain warning contradicts successful/paused completion");
		need(
			["answered", "delivered"].includes(receipt.outcome),
			"Ordinary plain turn is not answered/delivered",
		);
		const { saved } = await savedResult(client, record, beforeIds);
		result.tools = (saved.thinkingSegments ?? []).filter((segment) => segment.type === "tool_call");
		result.modelId = saved.modelId;
		identify(record, result);
		record.allowedOutcomes = ["answered", "delivered"];
		need(normalize(result.answer) === normalize(saved.content), "Plain/saved answer disagreement");
		assertOrdinary(result, spec.expected, modelId, spec.tool);
		const usage = await readUsage(client, record.conversationId, saved.id);
		record.costUsdMicros = Math.round(usage.costUsd * 1_000_000);
		return record;
	}
	let stopIssued = false;
	result = await consumeStream(client, "/api/chat/stream", body, {
		onPart: async (part, state) => {
			identify(record, state);
			if (
				!(spec.stop || spec.reconnect) ||
				part.type !== "data-tool-call" ||
				part.data?.status !== "done"
			)
				return false;
			if (spec.stop && !stopIssued) {
				stopIssued = true;
				await client.json("/api/chat/stream/stop", { streamId: record.streamId });
			}
			return spec.reconnect;
		},
	});
	if (spec.reconnect) {
		need(result.detached, "Disconnect control missed its tool-settlement boundary");
		// Observe-existing intent uses the stable existing reconnect API; never start-new.
		const status = await client.json(
			`/api/chat/stream/status?conversationId=${encodeURIComponent(record.conversationId)}`,
		);
		need(typeof status.hasOrphanedStream === "boolean", "Unknown reconnect-status protocol");
		record.observedStatus = { hasOrphanedStream: status.hasOrphanedStream };
		result = await consumeStream(
			client,
			"/api/chat/stream",
			{ ...body, reconnectToStreamId: record.streamId },
			{
				onPart: async (_part, state) => {
					identify(record, state);
				},
			},
		);
	}
	identify(record, result);
	need(result.modelId === modelId, "Actual stream model differs from requested staging model");
	if (spec.stop) {
		need(
			stopIssued && result.terminal && result.completion?.outcome === "stopped",
			"Stop control did not end stopped",
		);
		record.control = "stopped-after-tool";
		return record;
	}
	if (spec.pause) {
		need(
			result.terminal && result.completion?.outcome === "paused",
			"Model did not pause for the person",
		);
		const listing = await client.json(`/api/conversations/${record.conversationId}/questions`);
		const questions = listing.questions.filter((q) => q.status === "waiting");
		need(questions.length === 1, "Pause has no unique waiting question");
		const question = questions[0];
		need(
			question.questions?.[0]?.options?.[0]?.label === "17 times 23",
			"Pause options differ from synthetic choice",
		);
		record.pausedSegment = {
			turnId: result.completion.turnId,
			segmentId: result.completion.segmentId,
			outcome: "paused",
			assistantMessageId: result.assistantMessageId,
			requestedModelId: modelId,
			modelId: result.modelId,
			conversationId: record.conversationId,
		};
		record.resumeStreamId = randomUUID();
		result = await consumeStream(
			client,
			`/api/conversations/${record.conversationId}/questions/${question.id}/answer`,
			{
				streamId: record.resumeStreamId,
				answer: { kind: "answered", answers: [{ picked: [0], ownWords: null }] },
			},
			{
				onPart: async (_part, state) => {
					identify(record, state);
				},
			},
		);
		identify(record, result);
		assertOrdinary(result, { PRODUCT: "391" }, modelId, "run_python");
	} else if (spec.guard) record.control = assertGuard(result);
	else {
		if (!(spec.filename || spec.artifactTitle))
			assertOrdinary(result, spec.expected, modelId, spec.tool);
		if (spec.alsoTool)
			need(
				result.tools.some(
					(t) => t.name === spec.alsoTool && t.status === "done" && t.metadata?.ok !== false,
				),
				`Required tool absent: ${spec.alsoTool}`,
			);
	}
	if (result.completion?.outcome === "answered" || result.completion?.outcome === "delivered") {
		const { saved, detail } = await savedResult(client, record, beforeIds);
		need(normalize(saved.content) === normalize(result.answer), "Live/saved answer disagreement");
		if (spec.artifactTitle) {
			const made = detail.artifacts.filter((a) => a.title === spec.artifactTitle);
			need(made.length === 1, "Expected one durable Document effect");
			const artifact = await client.json(
				`/api/artifacts/${made[0].id}?conversationId=${record.conversationId}`,
			);
			need(
				normalize(artifact.artifact.body) === normalize(spec.evidence),
				"Full delivered Document body differs from synthetic evidence",
			);
			record.artifactId = made[0].id;
		}
		if (spec.filename) {
			const made = detail.generatedFiles.filter((f) => f.filename === spec.filename);
			need(made.length === 1, "Expected one durable generated file effect");
			const file = await client.request(`/api/chat/files/${made[0].id}/download`);
			need(
				file.ok && normalize(await file.text()) === "# Synthetic result\n\nPRODUCT=391",
				"Delivered file content mismatch",
			);
			record.fileId = made[0].id;
		}
		if (spec.filename || spec.artifactTitle)
			assertOrdinary(result, spec.expected, modelId, spec.tool, true);
		const usage = await readUsage(client, record.conversationId, saved.id);
		record.costUsdMicros = Math.round(usage.costUsd * 1_000_000);
	}
	if (spec.filename || spec.artifactTitle)
		need(record.fileId || record.artifactId, "Delivery has no verified durable output");
	return record;
}

function save(file, value) {
	const temp = `${file}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temp, file);
}
export async function main(argv = process.argv.slice(2)) {
	const flags = new Set(["--execute", "--plan", "--help"]),
		args = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		need(
			[
				"--execute",
				"--plan",
				"--help",
				"--out",
				"--families",
				"--inspect",
				"--audit-json",
				"--model-metadata-json",
			].includes(key),
			"Unknown CLI option",
		);
		args[key] = flags.has(key) ? true : argv[++i];
		need(args[key] !== undefined, "Missing CLI value");
	}
	if (args["--help"]) {
		console.log(
			"verify-contract.mjs --plan | --execute --families deepseek,kimi,qwen --out REPORT.json [--model-metadata-json STAGE-MODELS.json] | --inspect REPORT.json --audit-json AUDIT.json\nExecution requires dedicated synthetic staging EMAIL/PASSWORD, BASE, APP_ORIGIN. Normal accounts require the trusted stage model-metadata JSON; omitting it uses existing admin metadata access. No DB queries are executed. Audit remains a separate read-only, exact-ID verification step.",
		);
		return 0;
	}
	if (args["--plan"]) {
		console.log(
			JSON.stringify({ models: MODEL_MATRIX, scenarios: syntheticPlan("offline-plan") }, null, 2),
		);
		return 0;
	}
	if (args["--inspect"]) {
		need(args["--audit-json"], "Offline inspection requires --audit-json");
		const report = JSON.parse(readFileSync(args["--inspect"], "utf8"));
		need(report.status === "http-checks-passed-audit-pending", "HTTP checks did not all pass");
		report.audit = inspectAudit(
			JSON.parse(readFileSync(args["--audit-json"], "utf8")),
			report.identities,
		);
		report.status = "verified-http-and-audit";
		save(args["--inspect"], report);
		return 0;
	}
	const base = process.env.BASE ?? "http://127.0.0.1:3002";
	validateTarget({ base, execute: args["--execute"] });
	need(args["--out"], "--out is required before staging work");
	const families = (args["--families"] ?? "deepseek,kimi,qwen").split(",");
	need(
		families.length &&
			families.every((f) => Object.hasOwn(MODEL_MATRIX, f)) &&
			new Set(families).size === families.length,
		"Use each supported family once; no DeepSeek pro",
	);
	// No credentials are accessed by imports, offline plans or unit tests.
	const email = process.env.EMAIL,
		password = process.env.PASSWORD;
	need(email && password, "Dedicated staging EMAIL/PASSWORD are required");
	const interrupt = new AbortController();
	const onInterrupt = () => interrupt.abort();
	process.once("SIGINT", onInterrupt);
	const client = createClient({
		base: base.replace(/\/$/, ""),
		origin: process.env.APP_ORIGIN ?? "https://ai.dev.alfydesign.com",
		signal: interrupt.signal,
	});
	const runId = randomUUID(),
		records = [],
		created = [],
		identities = [];
	let setupPhase = "metadata-file",
		trustedMetadata,
		preflight;
	const persist = (report) => {
		const value = {
			...report,
			runId,
			base,
			createdConversations: created,
			records,
			identities,
			...(trustedMetadata ? { modelMetadata: trustedMetadata.provenance } : {}),
			...(preflight
				? { modelMetadata: preflight.provenance, modelBindings: preflight.bindings }
				: {}),
			limitations: [
				"No forced-budget/length/failover/content-filter coverage claimed from ordinary real-model calls",
				"Receipt completion is checked on both transports; durable outcomes require external exact-ID audit",
				"Disconnect is after a received tool result, not a forced in-flight lost-finish or replay-buffer overflow",
				"Live HTTP cannot prove activity fade or browser Copy behavior",
			],
		};
		save(args["--out"], value);
		if (identities.length) writeFileSync(`${args["--out"]}.audit.sql`, buildAuditSql(identities));
	};
	const items = families.flatMap((family) =>
		syntheticPlan(`${runId}-${family}`).map((spec) => ({ family, spec })),
	);
	const shared = new Map();
	try {
		await persist({ status: "running", results: [] });
		if (args["--model-metadata-json"] !== undefined) {
			try {
				trustedMetadata = parseModelMetadata(readFileSync(args["--model-metadata-json"]), families);
			} catch {
				throw new SetupFailure("invalid-model-metadata", "Invalid trusted stage model metadata");
			}
		}
		setupPhase = "login";
		const login = await client.json("/api/auth/login", { email, password, rememberMe: false });
		need(!login.twoStep, "Dedicated test account must not require two-step login");
		preflight = await verifyModelBindings(client, families, trustedMetadata, (phase) => {
			setupPhase = phase;
		});
		setupPhase = null;
		const report = await runSerial(
			items,
			async ({ family, spec }) => {
				const record = {
					family,
					scenario: spec.key,
					modelId: MODEL_MATRIX[family],
					requestedModelId: MODEL_MATRIX[family],
					streamId: randomUUID(),
				};
				records.push(record); // persisted even if create/send/assertion throws
				let id = spec.shared ? shared.get(family) : null;
				if (!id) {
					const made = await client.json("/api/conversations", {
						title: `Contract ${runId} ${family} ${spec.key}`,
					});
					id = made.id ?? made.conversation?.id ?? made.conversationId;
					need(typeof id === "string", "Create returned no conversation ID");
					created.push(id);
					if (spec.shared) shared.set(family, id);
				}
				record.conversationId = id;
				await persist({ status: "running", results: [] });
				try {
					await runCase(client, spec, MODEL_MATRIX[family], record);
				} finally {
					if (record.segmentId || record.turnId || record.assistantMessageId)
						identities.push({
							conversationId: id,
							segmentId: record.segmentId,
							turnId: record.turnId,
							assistantMessageId: record.assistantMessageId,
							outcome: record.outcome,
							allowedOutcomes: record.allowedOutcomes,
							modelId: record.modelId,
							requestedModelId: record.requestedModelId,
							costUsdMicros: record.costUsdMicros,
						});
					if (record.pausedSegment) identities.push(record.pausedSegment);
				}
				return { family, scenario: spec.key, conversationId: id, control: record.control ?? null };
			},
			persist,
		);
		return report.status === "failed" ? 1 : 3; // audit-pending is never full acceptance
	} catch (error) {
		await persist({
			status: "failed",
			failure:
				"Setup/transport/contract failure; inspect only generated records, no automatic retry",
			...(setupPhase ? { setupFailure: setupDiagnostic(setupPhase, error) } : {}),
		});
		return 1;
	} finally {
		// Never leave a live control/failed turn running. Stop only IDs allocated here.
		for (const record of records)
			if (!record.terminal) {
				for (const streamId of [record.streamId, record.resumeStreamId].filter(Boolean))
					await client.json("/api/chat/stream/stop", { streamId }).catch(() => undefined);
			}
		process.removeListener("SIGINT", onInterrupt);
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch(() => {
			console.error(
				"Contract runner failed; check arguments or the partial report. No credentials logged.",
			);
			process.exitCode = 1;
		});
}
