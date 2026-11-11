import { randomUUID } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { NormalChatModelRunProvider } from "../src/lib/server/services/normal-chat-model";

import { normalizeOpenAICompatibleBaseUrl } from "../src/lib/server/services/openai-compatible-url";

const STAGE_ROOT = "/home/alfydesign/apps/langflow-chat-dev";
const STAGE_ORIGIN = "https://ai.dev.alfydesign.com";
class ProofFailure extends Error {}
function need(condition: unknown, code: string): asserts condition {
	if (!condition) throw new ProofFailure(code);
}
export function assertStageIdentity(input: {
	cwd: string;
	databasePath: string;
	origin: string;
}) {
	need(input.origin === STAGE_ORIGIN, "not_staging_origin");
	need(
		new RegExp(`^${STAGE_ROOT}/releases/[a-f0-9]{7,40}$`).test(input.cwd),
		"not_staging_release",
	);
	need(
		input.databasePath === `${STAGE_ROOT}/shared/data/chat.db`,
		"not_staging_database",
	);
}
export function assertClosingBinding(input: {
	family: string;
	providerName: string;
	modelName: string;
	baseUrl: string;
	expectedProviderName: string;
	expectedModelName: string;
	expectedOrigin: string;
}) {
	const base = new URL(input.baseUrl);
	const expected = new URL(input.expectedOrigin);
	need(
		expected.origin === input.expectedOrigin &&
			!base.username &&
			!base.password &&
			base.origin === expected.origin,
		"unexpected_provider_origin",
	);
	need(
		input.providerName === input.expectedProviderName &&
			input.modelName === input.expectedModelName,
		"provider_binding_mismatch",
	);
	need(
		(input.family === "deepseek" &&
			input.providerName === "deepseek" &&
			input.modelName === "deepseek-flash" &&
			base.origin === "https://api.deepseek.com") ||
			(input.family === "kimi" && /kimi/i.test(input.modelName)) ||
			(input.family === "qwen" && /qwen/i.test(input.modelName)),
		"unsupported_provider_family",
	);
}

export function createClosingGateway(input: {
	caseName: "A" | "B";
	endpoint: string;
	modelName?: string;
	disableThinking?: boolean;
	fetch: typeof fetch;
}) {
	let phase: "working" | "closing" | undefined;
	const requests: Array<{ phase: string; cap: number; tools: number }> = [];
	return {
		requests,
		enter(next: "working" | "closing") {
			need(
				next === (requests.length === 0 ? "working" : "closing") &&
					requests.length < 2,
				"attempt_budget",
			);
			phase = next;
		},
		fetch: (async (url, init) => {
			need(
				phase &&
					requests.length < 2 &&
					phase === (requests.length === 0 ? "working" : "closing"),
				"request_budget",
			);
			need(
				String(url) === input.endpoint && init?.method === "POST",
				"unexpected_endpoint",
			);
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			need(
				body.model === (input.modelName ?? "deepseek-flash") &&
					body.stream === true,
				"unexpected_model",
			);
			const tools = Array.isArray(body.tools) ? body.tools.length : 0;
			need(phase !== "closing" || tools === 0, "closing_has_tools");
			const cap =
				input.caseName === "B" ? (phase === "working" ? 32 : 1024) : 512;
			requests.push({ phase, cap, tools });
			return input.fetch(url, {
				...init,
				redirect: "error",
				body: JSON.stringify({
					...body,
					max_tokens: cap,
					...((input.disableThinking ?? input.modelName === undefined)
						? { thinking: { type: "disabled" } }
						: {}),
				}),
			});
		}) satisfies typeof fetch,
	};
}
export type ClosingCaseInput = {
	caseName: "A" | "B";
	userId: string;
	provider: NormalChatModelRunProvider;
	modelId: `provider:${string}:${string}`;
	fetch: typeof fetch;
};
export async function runClosingCase(input: ClosingCaseInput) {
	const [
		{ db, sqlite },
		schema,
		{ eq, and },
		{ tool },
		{ z },
		model,
		lifetime,
		finalizer,
		projection,
		normalizer,
	] = await Promise.all([
		import("../src/lib/server/db"),
		import("../src/lib/server/db/schema"),
		import("drizzle-orm"),
		import("ai"),
		import("zod"),
		import("../src/lib/server/services/normal-chat-model"),
		import("../src/lib/server/services/chat-turn/completion-lifetime"),
		import("../src/lib/server/services/chat-turn/finalize"),
		import("../src/lib/shared/normal-chat-output"),
		import("../src/lib/server/services/chat-turn/normalizer"),
	]);
	const conversationId = randomUUID(),
		requestId = randomUUID();
	// Fresh fixture rows only. createConversation would opportunistically flush a
	// user's pending memory jobs; that is outside this two-request proof.
	db.insert(schema.conversations)
		.values({
			id: conversationId,
			userId: input.userId,
			title: `Closing proof ${input.caseName} ${requestId}`,
			memoryIncognito: false,
		})
		.run();
	const life = lifetime.beginCompletionLifetime({
		userId: input.userId,
		conversationId,
		requestId,
	});
	const gateway = createClosingGateway({
		caseName: input.caseName,
		endpoint: `${normalizeOpenAICompatibleBaseUrl(input.provider.baseUrl)}/chat/completions`,
		fetch: input.fetch,
		modelName: input.provider.modelName,
		disableThinking: input.provider.name === "deepseek",
	});
	let toolExecutions = 0,
		closingDeltas = 0;
	const prompt =
		input.caseName === "A"
			? "Call lookup_product once. Then answer exactly PRODUCT=391."
			: "Write the integers 1 through 200 in order, one per line, then END=200.";
	const report = {
		caseName: input.caseName,
		conversationId,
		requestId,
		segmentId: life.scope.segmentId,
		status: "failed",
		code: "runner_failed",
		requests: gateway.requests,
		toolExecutions: 0,
		closingDeltas: 0,
		answerBytes: 0,
		receiptMatches: false,
		attempts: [] as Array<{
			attemptId: string;
			phase: string;
			inputTokens: number | null;
			outputTokens: number | null;
			totalTokens: number | null;
			costUsdMicros: number | null;
			modelId: string;
			outcome: string | null;
			stopCause: string | null;
		}>,
		completion: null as unknown,
	};
	try {
		const { getConfig } = await import("../src/lib/server/config-store");
		const tools =
			input.caseName === "A"
				? {
						lookup_product: tool({
							description:
								"Read the synthetic product value. This read-only fixture always returns 391.",
							inputSchema: z.object({}),
							execute: async () => {
								toolExecutions++;
								need(toolExecutions === 1, "duplicate_tool");
								return { product: 391 };
							},
						}),
					}
				: undefined;
		const run = model.prepareNormalChatCompletionRun({
			provider: input.provider,
			modelId: input.modelId,
			runtimeConfig: { ...getConfig(), modelTimeoutFailoverEnabled: false },
			messages: [{ role: "user", content: prompt }],
			tools,
			toolChoice:
				input.caseName === "A"
					? { type: "tool", toolName: "lookup_product" }
					: undefined,
			maxToolSteps: 1,
			maxOutputTokens: input.caseName === "A" ? 512 : 1024,
			fetch: gateway.fetch,
			abortSignal: AbortSignal.timeout(120000),
			completionPolicy: {
				...life.scope,
				deadlineAt: Date.now() + 120000,
				totalTimeoutMs: 120000,
				onSnapshot: life.capture,
				onOutputEvent: (event) => {
					if (
						event.phase === "closing" &&
						event.type === "block_delta" &&
						event.text
					)
						closingDeltas++;
				},
				forAttempt: async (context) => {
					gateway.enter(context.phase);
					await life.register({
						attemptId: context.attemptId,
						phase: context.phase,
						providerId: context.provider.id,
						modelId: context.modelId,
						providerModelName: context.provider.modelName,
					});
					return { classifyExecution: () => "succeeded" as const };
				},
			},
		});
		for await (const _event of run.stream()) {
			/* The real streamed driver owns settlement. */
		}
		const snapshot = life.getSnapshot();
		need(snapshot?.completion, "missing_completion");
		report.completion = snapshot.completion;
		const answer = normalizer.normalizeAssistantOutputWithSkillControl(
			projection.projectNormalChatOutput(snapshot.events).answer,
			{ structuredOutput: true, skillControlEnabled: false },
		).visibleText;
		report.answerBytes = Buffer.byteLength(answer);
		// This is real persistence/accounting, with only the expensive turn-state tail
		// disabled. The pre-titled row prevents the title service from calling a model.
		let receiptId: string | undefined;
		const saved = await finalizer.finalizeChatTurn({
			turnKind: "send",
			streamId: requestId,
			userId: input.userId,
			conversationId,
			userMessageContent: prompt,
			persistUserMessage: true,
			normalizedMessage: prompt,
			upstreamMessage: prompt,
			assistantResponse: answer,
			assistantMetadata: {},
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: { model: input.modelId, turnSegmentId: life.scope.segmentId },
			assistantMirrorContent: answer,
			maintenanceReason: "chat_send",
			persistTurnState: false,
			responseLanguage: "en",
			completionTurn: {
				segmentId: life.scope.segmentId,
				getSnapshot: life.getSnapshot,
				finish: async (id) => {
					receiptId = id;
					await life.finish(id);
				},
			},
		});
		const { default: Database } = await import("better-sqlite3");
		const { drizzle } = await import("drizzle-orm/better-sqlite3");
		const readOnly = new Database(sqlite.name, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			readOnly.pragma("query_only = ON");
			const audit = drizzle(readOnly);
			const turns = audit
				.select()
				.from(schema.normalChatTurns)
				.where(eq(schema.normalChatTurns.conversationId, conversationId))
				.all();
			need(turns.length === 1, "terminal_row_count");
			const turn = turns[0];
			const attempts = audit
				.select()
				.from(schema.normalChatAttempts)
				.where(eq(schema.normalChatAttempts.segmentId, life.scope.segmentId))
				.all();
			report.attempts = attempts.map((a) => ({
				attemptId: a.attemptId,
				phase: a.phase,
				inputTokens: a.inputTokens,
				outputTokens: a.outputTokens,
				totalTokens: a.totalTokens,
				costUsdMicros: a.costUsdMicros,
				modelId: a.modelId,
				outcome: a.outcome,
				stopCause: a.safeStopCause,
			}));
			const rows = audit
				.select()
				.from(schema.messages)
				.where(
					and(
						eq(schema.messages.conversationId, conversationId),
						eq(schema.messages.role, "assistant"),
					),
				)
				.all();
			report.receiptMatches =
				rows.length === 1 &&
				rows[0].id === receiptId &&
				rows[0].id === saved.assistantMessage?.id &&
				rows[0].id === turn.messageId &&
				rows[0].content === answer;
			need(report.receiptMatches, "receipt_disagreement");
			need(
				turn.accountingStatus === "ready" &&
					attempts.length === 2 &&
					attempts.every(
						(a) =>
							a.usageFinal &&
							typeof a.outcome === "string" &&
							a.outcome.length > 0 &&
							typeof a.safeStopCause === "string" &&
							a.safeStopCause.length > 0 &&
							a.inputTokens !== null &&
							a.outputTokens !== null &&
							a.totalTokens !== null &&
							a.costUsdMicros !== null &&
							a.providerId === input.provider.id &&
							a.modelId === input.modelId,
					),
				"accounting_not_ready",
			);
			need(
				attempts.filter((a) => a.phase === "working").length === 1 &&
					attempts.filter((a) => a.phase === "closing").length === 1,
				"attempt_phase_mismatch",
			);
			need(
				JSON.stringify([...JSON.parse(turn.attemptIdsJson ?? "[]")].sort()) ===
					JSON.stringify(attempts.map((a) => a.attemptId).sort()),
				"attempt_manifest",
			);
			need(
				turn.closingAttempted &&
					turn.phase === "closing" &&
					turn.outcome === snapshot.completion.outcome &&
					turn.outcome === "answered",
				"closing_not_answered",
			);
			need(
				turn.workingStopCause ===
					(input.caseName === "A" ? "tool_budget" : "length"),
				"working_exit_not_observed",
			);
			need(
				gateway.requests.length === 2 &&
					closingDeltas > 0 &&
					answer.trim().length > 0,
				"missing_closing_stream",
			);
			need(
				toolExecutions === (input.caseName === "A" ? 1 : 0),
				"tool_execution_count",
			);
			if (input.caseName === "A")
				need(answer.trim() === "PRODUCT=391", "wrong_answer");
			report.status = "passed";
			report.code = "ok";
		} finally {
			readOnly.close();
		}
	} catch (error) {
		report.code =
			error instanceof ProofFailure ? error.message : "runner_failed";
		await life.finish().catch(() => undefined);
	}
	report.toolExecutions = toolExecutions;
	report.closingDeltas = closingDeltas;
	return report;
}

async function main() {
	const { values } = parseArgs({
		options: {
			execute: { type: "boolean" },
			"user-id": { type: "string" },
			"user-email": { type: "string" },
			"provider-id": { type: "string" },
			"model-id": { type: "string" },
			family: { type: "string", default: "deepseek" },
			"provider-name": { type: "string", default: "deepseek" },
			"model-name": { type: "string", default: "deepseek-flash" },
			"expected-origin": {
				type: "string",
				default: "https://api.deepseek.com",
			},
			report: { type: "string" },
		},
	});
	if (!values.execute) {
		console.log(
			"Staging only; explicit DeepSeek Flash/Kimi/Qwen binding; cases A/B; at most two requests each, no auxiliary calls or retries. --execute requires owner authorization. See closing-provider-proposal.md.",
		);
		return;
	}
	need(
		values["user-id"] &&
			values["user-email"] &&
			values["provider-id"] &&
			values["model-id"] &&
			values.report,
		"missing_arguments",
	);
	need(
		/^(?:turn-completion|completion)[+._-][^@]+@[^@]+\.(?:test|invalid)$/i.test(
			values["user-email"],
		),
		"not_synthetic_account",
	);
	// Validate location before loading .env or the server module graph.
	const cwd = realpathSync(process.cwd());
	need(
		new RegExp(`^${STAGE_ROOT}/releases/[a-f0-9]{7,40}$`).test(cwd),
		"not_staging_release",
	);
	const { config } = await import("dotenv");
	config({ quiet: true });
	const { getDatabasePath } = await import("../src/lib/server/env");
	assertStageIdentity({
		cwd,
		databasePath: realpathSync(resolve(getDatabasePath())),
		origin: process.env.ORIGIN ?? "",
	});
	const output = resolve(values.report);
	writeFileSync(output, JSON.stringify({ status: "started", cases: [] }), {
		flag: "wx",
		mode: 0o600,
	});
	const nativeFetch = globalThis.fetch.bind(globalThis);
	let auxiliaryCalls = 0;
	globalThis.fetch = async (url, init) => {
		if (String(url).startsWith("data:")) return nativeFetch(url, init);
		auxiliaryCalls++;
		throw new ProofFailure("auxiliary_request_blocked");
	};
	// SDK errors can include upstream request data. Only the safe report is output.
	for (const method of ["log", "info", "debug", "warn", "error"] as const)
		console[method] = () => {};
	const [{ db }, schema, { eq }, providers, models] = await Promise.all([
		import("../src/lib/server/db"),
		import("../src/lib/server/db/schema"),
		import("drizzle-orm"),
		import("../src/lib/server/services/providers"),
		import("../src/lib/server/services/provider-models"),
	]);
	const user = db
		.select({ id: schema.users.id, email: schema.users.email })
		.from(schema.users)
		.where(eq(schema.users.id, values["user-id"]))
		.get();
	need(user?.email === values["user-email"], "synthetic_identity_mismatch");
	const provider = await providers.getProviderWithSecrets(
			values["provider-id"],
		),
		model = await models.getProviderModel(values["model-id"]);
	need(
		provider?.enabled &&
			model?.enabled &&
			model.providerId === provider.id &&
			model.maxModelContext &&
			model.maxModelContext >= 8192,
		"provider_binding_mismatch",
	);
	assertClosingBinding({
		family: values.family,
		providerName: provider.name,
		modelName: model.name,
		baseUrl: provider.baseUrl,
		expectedProviderName: values["provider-name"],
		expectedModelName: values["model-name"],
		expectedOrigin: values["expected-origin"],
	});
	const binding: NormalChatModelRunProvider = {
		id: provider.id,
		name: provider.name,
		displayName: model.displayName,
		baseUrl: provider.baseUrl,
		modelName: model.name,
		apiKey: providers.decryptApiKey(
			provider.apiKeyEncrypted,
			provider.apiKeyIv,
		),
		maxModelContext: model.maxModelContext,
		thinkingType:
			provider.name === "deepseek"
				? "disabled"
				: (model.thinkingType ?? undefined),
		reasoningEffort: model.reasoningEffort ?? undefined,
	};
	const results = [];
	for (const caseName of ["A", "B"] as const) {
		results.push(
			await runClosingCase({
				caseName,
				userId: user.id,
				provider: binding,
				modelId: `provider:${provider.id}:${model.id}`,
				fetch: nativeFetch,
			}),
		);
		writeFileSync(
			output,
			JSON.stringify(
				{ status: "running", auxiliaryCalls, cases: results },
				null,
				2,
			),
			{ mode: 0o600 },
		);
		if (auxiliaryCalls) break;
	}
	const passed =
		results.length === 2 &&
		results.every((r) => r.status === "passed") &&
		auxiliaryCalls === 0;
	writeFileSync(
		output,
		JSON.stringify(
			{ status: passed ? "passed" : "failed", auxiliaryCalls, cases: results },
			null,
			2,
		),
		{ mode: 0o600 },
	);
	process.exit(passed ? 0 : 1);
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof ProofFailure ? error.message : "closing_proof_setup_failed"}\n`,
		);
		process.exit(1);
	});
}
