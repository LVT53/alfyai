import { generateText } from "ai";

// Server-side modules (DB, provider secrets) are imported dynamically inside
// functions so this file is safe to import before env/DATABASE_PATH are set.

export type ModelClient = {
	label: string;
	providerName: string;
	apiModelName: string;
	// biome-ignore lint/suspicious/noExplicitAny: AI SDK LanguageModel
	model: any;
};

export async function resolveModelClient(opts: {
	providerName: string;
	apiModelName: string;
	requireKey?: boolean;
	vllmThinkingOff?: boolean;
}): Promise<ModelClient | null> {
	const { getProviderByName, getProviderWithSecrets, decryptApiKey } =
		await import("../../../src/lib/server/services/providers");
	const { createOpenAICompatibleProviderForNormalChatModelRun } = await import(
		"../../../src/lib/server/services/normal-chat-model/openai-compatible-provider"
	);

	const prov = await getProviderByName(opts.providerName);
	if (!prov) return null;
	const secrets = await getProviderWithSecrets(prov.id);
	if (!secrets) return null;

	let apiKey = "";
	try {
		if (secrets.apiKeyEncrypted && secrets.apiKeyIv) {
			apiKey = decryptApiKey(secrets.apiKeyEncrypted, secrets.apiKeyIv);
		}
	} catch {
		/* no/invalid key */
	}
	if (opts.requireKey && !apiKey) return null;

	const qwenThinkingOff = { enable_thinking: false };
	const factory = createOpenAICompatibleProviderForNormalChatModelRun({
		provider: {
			name: prov.name,
			displayName: prov.displayName,
			baseUrl: prov.baseUrl,
			modelName: opts.apiModelName,
			apiKey: apiKey || undefined,
		},
		includeUsage: true,
		normalizeStreaming: false,
		transformRequestBody: opts.vllmThinkingOff
			? (args: Record<string, unknown>) => ({
					...args,
					chat_template_kwargs: qwenThinkingOff,
					extra_body: { chat_template_kwargs: qwenThinkingOff },
				})
			: undefined,
	});

	return {
		label: `${opts.providerName}:${opts.apiModelName}`,
		providerName: opts.providerName,
		apiModelName: opts.apiModelName,
		model: factory(opts.apiModelName),
	};
}

export type ModelCall = {
	text: string;
	latencyMs: number;
	inputTokens?: number;
	outputTokens?: number;
	error?: string;
};

export async function callModel(
	client: ModelClient,
	params: {
		system: string;
		user: string;
		temperature?: number;
		maxOutputTokens?: number;
	},
): Promise<ModelCall> {
	const started = Date.now();
	try {
		const res = await generateText({
			model: client.model,
			system: params.system,
			messages: [{ role: "user", content: params.user }],
			temperature: params.temperature ?? 0,
			maxOutputTokens: params.maxOutputTokens ?? 1400,
			maxRetries: 2,
		});
		// biome-ignore lint/suspicious/noExplicitAny: usage shape varies by SDK
		const usage = (res as any).usage ?? {};
		return {
			text: (res.text || "").trim(),
			latencyMs: Date.now() - started,
			inputTokens: usage.inputTokens ?? usage.promptTokens,
			outputTokens: usage.outputTokens ?? usage.completionTokens,
		};
	} catch (error) {
		return {
			text: "",
			latencyMs: Date.now() - started,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export type Judgement = {
	score: number; // 0-3
	correct: boolean; // score >= 2
	hallucination: boolean;
	citedUrl: boolean;
	reason: string;
	raw?: string;
	error?: string;
};

const JUDGE_SYSTEM = `You are a strict, fair grader of factual answers. You are given a QUESTION, a GOLD ANSWER (the verified ground truth), optional GRADING NOTES, and a CANDIDATE ANSWER produced by another AI using web search results.

Score how well the CANDIDATE matches the GOLD ANSWER's facts:
- 3 = all key facts present and correct.
- 2 = mostly correct; a minor omission or imprecision that a reasonable person would still call correct.
- 1 = partially correct, or missing a key required part.
- 0 = incorrect, unsupported, fabricated, or the candidate says it could not find the information.

Also set:
- "hallucination": true if the candidate asserts a specific fact that contradicts the gold answer or appears fabricated.
- "cited_url": true if the candidate includes at least one http(s) URL or markdown link.

If GRADING NOTES are provided, follow them and accept any reasonable valid interpretation (e.g. different but legitimate trims, metros, or figures within stated tolerance).

Respond with ONLY compact JSON, no prose:
{"score":0,"hallucination":false,"cited_url":false,"reason":"one sentence"}`;

export async function judgeAnswer(
	judge: ModelClient,
	params: {
		question: string;
		goldAnswer: string;
		gradingNotes?: string;
		candidateAnswer: string;
	},
): Promise<Judgement> {
	const user = [
		`QUESTION:\n${params.question}`,
		`GOLD ANSWER:\n${params.goldAnswer}`,
		params.gradingNotes ? `GRADING NOTES:\n${params.gradingNotes}` : "",
		`CANDIDATE ANSWER:\n${params.candidateAnswer || "(empty)"}`,
	]
		.filter(Boolean)
		.join("\n\n");

	const call = await callModel(judge, {
		system: JUDGE_SYSTEM,
		user,
		temperature: 0,
		maxOutputTokens: 400,
	});
	if (call.error) {
		return {
			score: 0,
			correct: false,
			hallucination: false,
			citedUrl: false,
			reason: `judge error: ${call.error}`,
			error: call.error,
		};
	}
	const parsed = parseJudgement(call.text);
	return { ...parsed, raw: call.text };
}

function parseJudgement(
	text: string,
): Omit<Judgement, "raw"> {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) {
		return {
			score: 0,
			correct: false,
			hallucination: false,
			citedUrl: false,
			reason: `unparseable judge output: ${text.slice(0, 120)}`,
		};
	}
	try {
		const j = JSON.parse(match[0]);
		const score = Math.max(0, Math.min(3, Number(j.score) || 0));
		return {
			score,
			correct: score >= 2,
			hallucination: Boolean(j.hallucination),
			citedUrl: Boolean(j.cited_url),
			reason: String(j.reason ?? "").slice(0, 300),
		};
	} catch {
		return {
			score: 0,
			correct: false,
			hallucination: false,
			citedUrl: false,
			reason: `invalid judge JSON: ${text.slice(0, 120)}`,
		};
	}
}

// Try judge providers in preference order; return the first that resolves with
// a working key + a successful test call. Prefers a strong NON-DeepSeek judge.
export async function resolveJudge(): Promise<ModelClient | null> {
	const candidates: Array<{
		providerName: string;
		apiModelName: string;
		vllmThinkingOff?: boolean;
	}> = [
		{ providerName: "openai", apiModelName: "chat-latest" }, // GPT 5.5
		{
			providerName: "firepass-v2",
			apiModelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
		},
		{
			providerName: "model1",
			apiModelName: "qwen3-6-27b",
			vllmThinkingOff: true,
		},
	];
	for (const c of candidates) {
		const client = await resolveModelClient({ ...c, requireKey: false });
		if (!client) continue;
		const test = await callModel(client, {
			system: "Reply with the single word OK.",
			user: "Say OK.",
			maxOutputTokens: 20,
		});
		if (!test.error && /ok/i.test(test.text)) {
			console.log(`[judge] using ${client.label} (test ok in ${test.latencyMs}ms)`);
			return client;
		}
		console.log(
			`[judge] ${c.providerName}:${c.apiModelName} unavailable (${test.error ?? test.text.slice(0, 40)})`,
		);
	}
	return null;
}
