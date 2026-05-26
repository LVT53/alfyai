import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium, type Page } from "playwright";
import { stripLeakedToolDiagnostics } from "../src/lib/services/stream-protocol";

type ModelRef = {
	id: string;
	displayName?: string;
};

type StreamResult = {
	text: string;
	thinkingLength: number;
	metadata: Record<string, unknown> | null;
	toolCalls: Array<Record<string, unknown>>;
};

type ConversationDetail = {
	conversation?: { id: string; title?: string };
	messages?: Array<{ id: string; role: string; content: string }>;
	fileProductionJobs?: Array<Record<string, unknown>>;
	contextCompressionSnapshots?: Array<Record<string, unknown>>;
};

type AdminConfigResponse = {
	currentValues?: Record<string, unknown>;
	overrides?: Record<string, string>;
};

type InferenceProvider = {
	id: string;
	displayName: string;
	maxModelContext: number | null;
	compactionUiThreshold: number | null;
	targetConstructedContext: number | null;
	maxMessageLength: number | null;
	maxTokens: number | null;
};

type SweepStep = {
	name: string;
	ok: boolean;
	notes: string[];
	textLength?: number;
};

const baseUrl = process.env.LIVE_AI_BASE_URL ?? "https://ai.alfydesign.com";
const email = process.env.LIVE_AI_EMAIL;
const password = process.env.LIVE_AI_PASSWORD;
const headless = process.env.LIVE_AI_HEADLESS !== "false";
const keepConversations = process.env.LIVE_AI_KEEP_CONVERSATIONS !== "false";
const timeoutMs = Number(process.env.LIVE_AI_TIMEOUT_MS ?? 420_000);
const outputDir =
	process.env.LIVE_AI_OUTPUT_DIR ??
	path.join(
		process.cwd(),
		"test-results",
		`live-ai-sweep-${new Date().toISOString().replace(/[:.]/g, "-")}`,
	);
const lowContextPass = {
	maxModelContext: Number(process.env.LIVE_AI_LOW_MAX_MODEL_CONTEXT ?? 14_000),
	compactionUiThreshold: Number(
		process.env.LIVE_AI_LOW_COMPACTION_UI_THRESHOLD ?? 3_500,
	),
	targetConstructedContext: Number(
		process.env.LIVE_AI_LOW_TARGET_CONSTRUCTED_CONTEXT ?? 4_500,
	),
	maxTokens: Number(process.env.LIVE_AI_LOW_MAX_TOKENS ?? 1_024),
};

const modelTargets = [
	{
		label: "gpt-oss",
		idEnv: "LIVE_AI_OSS_MODEL_ID",
		queryEnv: "LIVE_AI_OSS_MODEL_QUERY",
		defaultQuery: "gpt oss|gpt-oss|chatgpt oss|openai oss",
	},
	{
		label: "kimi",
		idEnv: "LIVE_AI_KIMI_MODEL_ID",
		queryEnv: "LIVE_AI_KIMI_MODEL_QUERY",
		defaultQuery: "kimi|k2.6|k2",
	},
];

const cycleNeedles = [
	"LANTERN-PAPAYA-17",
	"Inez Vale",
	"18742.60",
	"teal folder marked 9Q",
	"2026-06-18 14:30 Europe/Budapest",
	"North pier C-17",
	"RIVER-ONYX-41",
	"Tomasz Grell",
	"VX-4409",
	"Selyem utca 14, gate B",
	"ORCHID-TUNGSTEN-58",
	"Priya Sen",
	"Híd-3",
	"release/saffron-needle",
	"thermal label printer jams after 42 labels",
	"M-77",
];

function requireEnv(name: string, value: string | undefined): string {
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function assertValidLowContextPassConfig() {
	const { maxModelContext, compactionUiThreshold, targetConstructedContext } =
		lowContextPass;
	for (const [label, value] of Object.entries(lowContextPass)) {
		if (!Number.isInteger(value) || value < 1) {
			throw new Error(`Invalid ${label}: ${value}`);
		}
	}
	if (
		maxModelContext < 1_000 ||
		compactionUiThreshold < 1_000 ||
		targetConstructedContext < 1_000
	) {
		throw new Error("Low-context pass values must satisfy admin minimums");
	}
	if (
		compactionUiThreshold >= maxModelContext ||
		targetConstructedContext >= maxModelContext
	) {
		throw new Error(
			"Low-context threshold and target must be below maxModelContext",
		);
	}
	if (lowContextPass.maxTokens >= maxModelContext) {
		throw new Error("Low-context maxTokens must be below maxModelContext");
	}
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
}

function apiPath(value: string): string {
	return new URL(value, baseUrl).toString();
}

async function apiJson<T>(
	page: Page,
	url: string,
	init?: RequestInit,
): Promise<T> {
	const response = await authenticatedFetch(page, url, init);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
	}
	return JSON.parse(text) as T;
}

async function authenticatedFetch(
	page: Page,
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	const cookies = await page.context().cookies(baseUrl);
	const cookieHeader = cookies
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join("; ");
	if (cookieHeader) {
		headers.set("Cookie", cookieHeader);
	}
	return fetch(apiPath(url), {
		...init,
		headers,
	});
}

async function login(page: Page) {
	await page.goto(apiPath("/login"), { waitUntil: "domcontentloaded" });
	const response = await page.request.post(apiPath("/api/auth/login"), {
		data: {
			email: requireEnv("LIVE_AI_EMAIL", email),
			password: requireEnv("LIVE_AI_PASSWORD", password),
		},
		headers: { "Content-Type": "application/json" },
	});
	if (!response.ok()) {
		throw new Error(`Login failed with HTTP ${response.status()}`);
	}
	await page.goto(apiPath("/"), { waitUntil: "domcontentloaded" });
}

async function resolveModel(page: Page, target: (typeof modelTargets)[number]) {
	const explicitId = process.env[target.idEnv];
	const modelsPayload = await apiJson<{ models?: ModelRef[] }>(
		page,
		"/api/models",
	);
	const models = modelsPayload.models ?? [];
	if (explicitId) {
		const match = models.find((model) => model.id === explicitId);
		if (!match) {
			throw new Error(
				`${target.idEnv}=${explicitId} was not found in /api/models`,
			);
		}
		return match;
	}
	const rawQuery = process.env[target.queryEnv] ?? target.defaultQuery;
	const patterns = rawQuery
		.split("|")
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);
	const match = models.find((model) => {
		const haystack = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
		return patterns.some((pattern) => haystack.includes(pattern));
	});
	if (!match) {
		throw new Error(
			`Could not resolve ${target.label} model from query "${rawQuery}". Available models: ${models
				.map((model) => `${model.displayName ?? model.id} (${model.id})`)
				.join(", ")}`,
		);
	}
	return match;
}

async function createConversation(page: Page, title: string): Promise<string> {
	const conversation = await apiJson<{ id: string }>(
		page,
		"/api/conversations",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title, projectId: null }),
		},
	);
	return conversation.id;
}

async function getConversationDetail(
	page: Page,
	conversationId: string,
): Promise<ConversationDetail> {
	return apiJson<ConversationDetail>(
		page,
		`/api/conversations/${encodeURIComponent(conversationId)}`,
	);
}

async function streamTurn(
	page: Page,
	input: {
		conversationId: string;
		modelId: string;
		message: string;
		forceWebSearch?: boolean;
	},
): Promise<StreamResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await authenticatedFetch(page, "/api/chat/stream", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: input.message,
				conversationId: input.conversationId,
				streamId: crypto.randomUUID(),
				model: input.modelId,
				thinkingMode: "auto",
				forceWebSearch: input.forceWebSearch ? true : undefined,
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`stream HTTP ${response.status}: ${await response.text()}`);
		}
		if (!response.body) {
			throw new Error("stream response had no body");
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let currentEvent: string | null = null;
		let text = "";
		let thinkingLength = 0;
		let metadata: Record<string, unknown> | null = null;
		const toolCalls: Array<Record<string, unknown>> = [];
		let streamError: string | null = null;

		function handleData(rawData: string) {
			if (currentEvent === "token") {
				const parsed = JSON.parse(rawData);
				text += parsed.text ?? (typeof parsed === "string" ? parsed : "");
				return;
			}
			if (currentEvent === "thinking") {
				const parsed = JSON.parse(rawData);
				const chunk = parsed.text ?? (typeof parsed === "string" ? parsed : "");
				thinkingLength += chunk.length;
				return;
			}
			if (currentEvent === "tool_call") {
				toolCalls.push(JSON.parse(rawData));
				return;
			}
			if (currentEvent === "end") {
				metadata = JSON.parse(rawData);
				return;
			}
			if (currentEvent === "error") {
				const parsed = JSON.parse(rawData);
				streamError = parsed.error ?? rawData;
			}
		}

		function processBlock(block: string) {
			for (const rawLine of block.split(/\r?\n/)) {
				const line = rawLine.trimEnd();
				if (!line) continue;
				if (line.startsWith("event: ")) {
					currentEvent = line.slice("event: ".length).trim();
					continue;
				}
				if (line.startsWith("data: ")) {
					handleData(line.slice("data: ".length));
				}
			}
		}

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				processBlock(block);
				boundary = buffer.indexOf("\n\n");
			}
		}
		if (buffer.trim()) {
			processBlock(buffer);
		}
		if (streamError) {
			throw new Error(streamError);
		}
		return { text, thinkingLength, metadata, toolCalls };
	} finally {
		clearTimeout(timeout);
	}
}

async function runCompression(
	page: Page,
	conversationId: string,
	modelId: string,
	trigger: "manual" | "automatic" = "manual",
) {
	return apiJson<{ snapshot: Record<string, unknown> }>(
		page,
		`/api/conversations/${encodeURIComponent(conversationId)}/context-compression`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ selectedModelId: modelId, trigger }),
		},
	);
}

async function fetchAdminConfig(page: Page): Promise<AdminConfigResponse> {
	return apiJson<AdminConfigResponse>(page, "/api/admin/config");
}

async function updateAdminConfig(
	page: Page,
	payload: Record<string, string>,
): Promise<void> {
	await apiJson<{ success?: boolean }>(page, "/api/admin/config", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}

async function fetchProviders(page: Page): Promise<InferenceProvider[]> {
	const payload = await apiJson<{ providers?: InferenceProvider[] }>(
		page,
		"/api/admin/providers",
	);
	return payload.providers ?? [];
}

async function updateProviderLimits(
	page: Page,
	providerId: string,
	payload: Partial<
		Pick<
			InferenceProvider,
			| "maxModelContext"
			| "compactionUiThreshold"
			| "targetConstructedContext"
			| "maxMessageLength"
			| "maxTokens"
		>
	>,
): Promise<void> {
	await apiJson<{ provider?: InferenceProvider }>(
		page,
		`/api/admin/providers/${encodeURIComponent(providerId)}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
}

async function pollForFileJob(
	page: Page,
	conversationId: string,
): Promise<ConversationDetail> {
	const deadline = Date.now() + timeoutMs;
	let lastDetail = await getConversationDetail(page, conversationId);
	while (Date.now() < deadline) {
		const jobs = lastDetail.fileProductionJobs ?? [];
		const terminal = jobs.find((job) =>
			["succeeded", "failed", "cancelled"].includes(String(job.status ?? "")),
		);
		if (terminal) return lastDetail;
		await page.waitForTimeout(2000);
		lastDetail = await getConversationDetail(page, conversationId);
	}
	throw new Error("Timed out waiting for a file-production job to finish");
}

function webChromeLineCount(text: string): number {
	const chromeLine =
		/^(?:search|home|menu|contact|login|log in|sign in|register|favorites|cart|basket|orders|shop|webshop|categories|previous article|next article|privacy policy|terms|cookie settings|accept|facebook|copyright|impressum|keresés|főoldal|otthon|menü|kapcsolat|belépés|regisztráció|kedvencek|kosár|rendeléseim|kategóriák|címlapon|előző cikk|következő cikk|adatvédelmi nyilatkozat|adatkezelési beállítások|ászf|sütik|elfogadom)$/i;
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => chromeLine.test(line)).length;
}

function detectLeaks(text: string, mode: "web" | "file" | "general"): string[] {
	const findings: string[] = [];
	const checks: Array<[RegExp, string]> = [
		[
			/<thinking>|<\/thinking>|<tool_calls>|<\/tool_calls>/i,
			"thinking/tool tags",
		],
		[
			/run_python_repl:|Successfully imported modules|Code execution completed/i,
			"python tool diagnostics",
		],
		[
			/Found \d+ source files were useful|source files were useful/i,
			"web research diagnostics",
		],
		[
			/Traceback \(most recent call last\)|stderr:|MISSING:/i,
			"raw execution diagnostics",
		],
	];
	if (mode === "web") {
		checks.push(
			[
				/Belépés\/regisztráció|Kedvencek\s+Kosár|Az oldal sütiket használ|Adatkezelési beállítások/i,
				"raw Hungarian page chrome",
			],
			[
				/Kerékpárszállítók\s+vonóhorogra\s+Kerékpárszállítók\s+tetőre/i,
				"raw ecommerce navigation",
			],
		);
		if (webChromeLineCount(text) >= 4) {
			findings.push("too many raw webpage chrome lines");
		}
	}
	if (mode === "file") {
		checks.push(
			[
				/"documentSource"|"requestedOutputs"|"sourceMode"|"blocks"|"items"/i,
				"raw file-production JSON",
			],
			[
				/"type"\s*:\s*"paragraph"|"type"\s*:\s*"list"/i,
				"raw document-source blocks",
			],
			[
				/Let me fix the JSON formatting|JSON formatting for the document source/i,
				"file tool repair narration",
			],
		);
	}
	for (const [pattern, label] of checks) {
		if (pattern.test(text)) {
			findings.push(label);
		}
	}
	const cleaned = stripLeakedToolDiagnostics(text).trim();
	if (
		cleaned &&
		cleaned !== text.trim() &&
		Math.abs(cleaned.length - text.trim().length) > 60
	) {
		findings.push(
			"shared stream-protocol leak stripper would remove visible text",
		);
	}
	return findings;
}

function cyclePrompt(cycle: 1 | 2 | 3, modelLabel: string): string {
	if (cycle === 1) {
		return `Needle archive cycle 1 for ${modelLabel}. Do not browse. Please acknowledge briefly, but preserve these details for later recall after context compaction.

During a Monday operations review, Inez Vale prepared a field notebook for a migration rehearsal called LANTERN-PAPAYA-17. The relevant folder is a teal folder marked 9Q, not the nearby yellow binder, and the appointment is 2026-06-18 14:30 Europe/Budapest. The budget checksum is 18742.60. The physical handoff point is North pier C-17. These are the exact values that matter later.

Background noise for the same day: the team discussed invoice staging, a broken badge printer, three onboarding questions, and a vendor lunch that moved from the east office to the courtyard. Bela wanted the lunch order tracked with vegetarian counts, Eszter asked whether the old S3 bucket was still archived, and Mateo wrote a note about browser cache behavior during deployments. None of those side topics change the five exact facts above.

The project story continued with a long status report: the staging environment had stale screenshots, QA wanted a fixture for Hungarian number formatting, and the office router had a maintenance window. The relevant operations trail mentions a crate inventory, an accessibility pass, and a reminder to compare two PDF renderers. These details make the note realistic, but the key recall needles remain Inez Vale, LANTERN-PAPAYA-17, the teal folder marked 9Q, 2026-06-18 14:30 Europe/Budapest, 18742.60, and North pier C-17.`;
	}
	if (cycle === 2) {
		return `Needle archive cycle 2 for ${modelLabel}. Do not browse. Please acknowledge briefly and keep the facts distinct from the first cycle.

The second workday was about a compliance dry run named RIVER-ONYX-41. Tomasz Grell owned the audit checklist. The tiny invoice crumb that must survive later compaction is VX-4409. The fallback address is Selyem utca 14, gate B. The cafeteria mural count was 11 triangles. These are exact facts for later recall.

There were many unrelated work notes around it: a QA tester complained about dark-mode contrast, two migration tables needed row-count checks, and a release note mentioned that streaming errors should be friendlier. A separate paragraph talked about coffee machines, obsolete Slack channels, proxy headers, and a hallway conversation about whether a generated DOCX should use A4 margins or Letter margins. Those details are distracting by design.

For clarity, the important details are not the lunch order, not the old proxy ticket, and not the document margin debate. The important details are RIVER-ONYX-41, Tomasz Grell, VX-4409, Selyem utca 14, gate B, and 11 triangles on the cafeteria mural.`;
	}
	return `Needle archive cycle 3 for ${modelLabel}. Do not browse. Please acknowledge briefly and preserve these details after the next compaction.

The third operations narrative is for ORCHID-TUNGSTEN-58. Priya Sen is the owner. The bridge label is Híd-3. The git branch to remember is release/saffron-needle. The practical blocker is that the thermal label printer jams after 42 labels. The green crate code is M-77. These values should remain recoverable later.

Surrounding context: the release manager checked a rollback playbook, the design reviewer asked for a thinner compaction marker, and the test lead compared two models on the same workflow. A side discussion covered browser screenshots, PDF downloads, and whether Kimi should receive the same prompt sequence as GPT-OSS. Another unrelated update mentioned a bike rack regulation search, a generated report, and a database snapshot cleanup.

	Only the exact recall facts should be treated as needles: ORCHID-TUNGSTEN-58, Priya Sen, Híd-3, release/saffron-needle, thermal label printer jams after 42 labels, and M-77.`;
}

function automaticCompactionSeedPrompt(modelLabel: string): string {
	const sections = [
		[
			"Monday commute",
			"Nóra Varga took tram 49 after a delayed train, carried a canvas bag with a cracked blue thermos, and wrote that the rain started at 07:42 near Móricz Zsigmond körtér.",
		],
		[
			"Operations review",
			"The project codename was AUTOCOMP-QUARTZ-93, the bridge marker was Mályva-híd 12, and the responsible reviewer was Kende Farkas.",
		],
		[
			"Finance note",
			"The reimbursement checksum was 90413.77, the envelope was marked 6F, and the receipt stack was deliberately kept separate from the green travel ledger.",
		],
		[
			"Customer call",
			"A partner asked about PDF generation, but the actionable part was that the final report had to mention route Cobalt-8 and avoid exposing raw JSON.",
		],
		[
			"Workshop",
			"The team compared web search summaries against raw page text and wrote down that cookie banners, navigation menus, and tool diagnostics must never be visible in final answers.",
		],
		[
			"Afternoon deployment",
			"The deployment checklist mentioned a node restart, a short journalctl watch, a smoke test with Kimi, and an identical smoke test with the local GPT-OSS model.",
		],
		[
			"Evening retrospective",
			"The phrase 'memory should be discoverable, not silently thrown away' was written in the meeting notes next to a sketch of a thin context-compaction marker.",
		],
		[
			"Personal errands",
			"Nóra bought printer labels, replaced a keycard sleeve, and added a reminder to check whether a thermal printer still jammed after 42 labels.",
		],
	];
	const body = Array.from({ length: 3 }, (_, pass) =>
		sections
			.map(
				([heading, detail], index) =>
					`Pass ${pass + 1}, section ${index + 1} - ${heading}: ${detail} Additional work-trip context: the office was noisy, two unrelated invoices were discussed, a hallway conversation drifted into model latency, and the daily plan kept returning to keeping core transcript history intact until compaction is necessary.`,
			)
			.join("\n\n"),
	).join("\n\n");
	return `Automatic low-context compaction seed for ${modelLabel}. Do not browse. Store this realistic daily work-trip essay for later recall. The exact needles are AUTOCOMP-QUARTZ-93, Nóra Varga, Mályva-híd 12, Kende Farkas, 90413.77, envelope 6F, and route Cobalt-8.

${body}

End of seed essay. Acknowledge briefly.`;
}

const automaticCompactionFollowupPrompt =
	"Add this second realistic workday note without browsing: the same team later found that the compaction UI should distinguish automatic snapshots from manual snapshots, and that the live verification should keep provider settings restored even if the model stream fails. Also remember that the auto-compaction audit marker is SILVER-MANGO-204 and the fallback meeting room is Room 5D. Acknowledge briefly.";

const automaticCompactionRecallPrompt =
	'Return strict JSON only. Recall the automatic-compaction seed facts: {"codename":"","commuter":"","bridge_marker":"","reviewer":"","checksum":"","envelope":"","route":"","audit_marker":"","room":""}';

const webSearchPrompt =
	"Use web search to answer in Hungarian: Magyarországon hogyan igényelhető szürke rendszám vonóhorgos kerékpárszállítóhoz 2026-ban? Give a concise answer with source titles or URLs. Do not paste raw page text, navigation menus, cookie banners, search result dumps, or tool output.";

const filePrompt =
	"Create a one-page PDF file called context-sweep-summary.pdf with sections Overview, Checks, and Risks. Use the file generation tool. The PDF must mention LANTERN-PAPAYA-17, ORCHID-TUNGSTEN-58, and budget guard. In the chat reply, do not print JSON, document source, program source, tool arguments, or repair narration; only confirm the file was created.";

const recallPrompt = `Return strict JSON only. Based on the conversation so far, recall these exact fields from all three compacted cycles:
{
  "cycle1_codename": "",
  "cycle1_person": "",
  "cycle1_budget_checksum": "",
  "cycle1_folder": "",
  "cycle1_appointment": "",
  "cycle1_handoff": "",
  "cycle2_codename": "",
  "cycle2_audit_lead": "",
  "cycle2_invoice_crumb": "",
  "cycle2_fallback_address": "",
  "cycle2_mural_count": "",
  "cycle3_codename": "",
  "cycle3_owner": "",
  "cycle3_bridge": "",
  "cycle3_branch": "",
  "cycle3_blocker": "",
  "cycle3_crate_code": ""
}`;

async function screenshot(page: Page, modelLabel: string, name: string) {
	const file = path.join(outputDir, `${slug(modelLabel)}-${name}.png`);
	await page.screenshot({ path: file, fullPage: true });
	return file;
}

async function refreshConversationPage(page: Page, conversationId: string) {
	await page.goto(apiPath(`/chat/${conversationId}`), {
		waitUntil: "domcontentloaded",
	});
	await page.getByTestId("message-input").waitFor({
		state: "visible",
		timeout: 15_000,
	});
}

function providerIdFromModelId(modelId: string): string | null {
	return modelId.startsWith("provider:")
		? modelId.slice("provider:".length)
		: null;
}

function modelConfigKeys(modelId: string) {
	if (modelId !== "model1" && modelId !== "model2") {
		throw new Error(`Built-in model expected, got ${modelId}`);
	}
	const prefix = modelId === "model1" ? "MODEL_1" : "MODEL_2";
	return {
		maxModelContext: `${prefix}_MAX_MODEL_CONTEXT`,
		compactionUiThreshold: `${prefix}_COMPACTION_UI_THRESHOLD`,
		targetConstructedContext: `${prefix}_TARGET_CONSTRUCTED_CONTEXT`,
	};
}

async function withLowContextSettings<T>(
	page: Page,
	model: ModelRef,
	fn: () => Promise<T>,
): Promise<T> {
	const providerId = providerIdFromModelId(model.id);
	let restore = async () => {};
	if (providerId) {
		const providers = await fetchProviders(page);
		const provider = providers.find((candidate) => candidate.id === providerId);
		if (!provider) {
			throw new Error(`Provider ${providerId} not found`);
		}
		const shouldClampMaxTokens =
			typeof provider.maxTokens === "number" &&
			provider.maxTokens >= lowContextPass.maxModelContext;
		const lowPatch: Parameters<typeof updateProviderLimits>[2] = {
			maxModelContext: lowContextPass.maxModelContext,
			compactionUiThreshold: lowContextPass.compactionUiThreshold,
			targetConstructedContext: lowContextPass.targetConstructedContext,
			...(shouldClampMaxTokens ? { maxTokens: lowContextPass.maxTokens } : {}),
			// The provider route derives maxMessageLength whenever maxModelContext
			// changes unless the existing value is included. Preserve it here so
			// this live sweep does not silently rewrite unrelated provider limits.
			...(provider.maxMessageLength !== null
				? { maxMessageLength: provider.maxMessageLength }
				: {}),
		};
		const restorePatch: Parameters<typeof updateProviderLimits>[2] = {
			maxModelContext: provider.maxModelContext,
			compactionUiThreshold: provider.compactionUiThreshold,
			targetConstructedContext: provider.targetConstructedContext,
			maxTokens: provider.maxTokens,
			...(provider.maxMessageLength !== null
				? { maxMessageLength: provider.maxMessageLength }
				: {}),
		};
		restore = async () => {
			await updateProviderLimits(page, providerId, restorePatch);
		};
		await updateProviderLimits(page, providerId, lowPatch);
	} else {
		const config = await fetchAdminConfig(page);
		const currentValues = config.currentValues ?? {};
		const overrides = config.overrides ?? {};
		const keys = modelConfigKeys(model.id);
		for (const key of Object.values(keys)) {
			if (!(key in currentValues)) {
				throw new Error(
					`/api/admin/config did not return current value ${key}`,
				);
			}
		}
		const lowPayload = {
			[keys.maxModelContext]: String(lowContextPass.maxModelContext),
			[keys.compactionUiThreshold]: String(
				lowContextPass.compactionUiThreshold,
			),
			[keys.targetConstructedContext]: String(
				lowContextPass.targetConstructedContext,
			),
		};
		const restorePayload = {
			[keys.maxModelContext]: overrides[keys.maxModelContext] ?? "",
			[keys.compactionUiThreshold]: overrides[keys.compactionUiThreshold] ?? "",
			[keys.targetConstructedContext]:
				overrides[keys.targetConstructedContext] ?? "",
		};
		restore = async () => {
			await updateAdminConfig(page, restorePayload);
		};
		await updateAdminConfig(page, lowPayload);
	}

	try {
		return await fn();
	} finally {
		await restore();
	}
}

async function runModelSweep(page: Page, model: ModelRef, label: string) {
	const steps: SweepStep[] = [];
	const title = `live-ai-sweep ${label} ${new Date().toISOString()}`;
	const conversationId = await createConversation(page, title);
	await refreshConversationPage(page, conversationId);
	const screenshots: string[] = [await screenshot(page, label, "start")];

	async function recordTurn(
		name: string,
		message: string,
		mode: "web" | "file" | "general",
		forceWebSearch = false,
	) {
		const result = await streamTurn(page, {
			conversationId,
			modelId: model.id,
			message,
			forceWebSearch,
		});
		const leaks = detectLeaks(result.text, mode);
		const ok = leaks.length === 0;
		steps.push({
			name,
			ok,
			notes: ok ? ["no leak signatures detected"] : leaks,
			textLength: result.text.length,
		});
		await writeFile(
			path.join(outputDir, `${slug(label)}-${slug(name)}.json`),
			JSON.stringify(result, null, 2),
		);
		return result;
	}

	await recordTurn("cycle 1 archive", cyclePrompt(1, label), "general");
	const snapshot1 = await runCompression(page, conversationId, model.id);
	steps.push({
		name: "manual compaction 1",
		ok: snapshot1.snapshot.status === "valid",
		notes: [`status=${String(snapshot1.snapshot.status)}`],
	});

	const webTurn = await recordTurn(
		"web search leak check",
		webSearchPrompt,
		"web",
		true,
	);
	steps.push({
		name: "web search tool event",
		ok: webTurn.toolCalls.length > 0,
		notes: [`toolCallEvents=${webTurn.toolCalls.length}`],
	});
	await refreshConversationPage(page, conversationId);
	screenshots.push(await screenshot(page, label, "after-web-search"));

	await recordTurn("cycle 2 archive", cyclePrompt(2, label), "general");
	const snapshot2 = await runCompression(page, conversationId, model.id);
	steps.push({
		name: "manual compaction 2",
		ok: snapshot2.snapshot.status === "valid",
		notes: [`status=${String(snapshot2.snapshot.status)}`],
	});

	const fileTurn = await recordTurn(
		"file generation leak check",
		filePrompt,
		"file",
	);
	steps.push({
		name: "file generation tool event",
		ok: fileTurn.toolCalls.length > 0,
		notes: [`toolCallEvents=${fileTurn.toolCalls.length}`],
	});
	const fileDetail = await pollForFileJob(page, conversationId);
	const succeededJobs = (fileDetail.fileProductionJobs ?? []).filter(
		(job) => job.status === "succeeded",
	);
	steps.push({
		name: "file production job",
		ok: succeededJobs.length > 0,
		notes: [
			`succeededJobs=${succeededJobs.length}`,
			`replyLength=${fileTurn.text.length}`,
		],
	});
	await refreshConversationPage(page, conversationId);
	screenshots.push(await screenshot(page, label, "after-file-generation"));

	await recordTurn("cycle 3 archive", cyclePrompt(3, label), "general");
	const snapshot3 = await runCompression(page, conversationId, model.id);
	steps.push({
		name: "manual compaction 3",
		ok: snapshot3.snapshot.status === "valid",
		notes: [`status=${String(snapshot3.snapshot.status)}`],
	});

	const recall = await recordTurn(
		"post-compaction recall",
		recallPrompt,
		"general",
	);
	const missingNeedles = cycleNeedles.filter(
		(needle) => !recall.text.toLowerCase().includes(needle.toLowerCase()),
	);
	steps.push({
		name: "needle recall after 3 compactions",
		ok: missingNeedles.length === 0,
		notes:
			missingNeedles.length === 0
				? ["all expected needles found"]
				: [`missing: ${missingNeedles.join(", ")}`],
		textLength: recall.text.length,
	});
	await refreshConversationPage(page, conversationId);
	screenshots.push(await screenshot(page, label, "final-recall"));

	const detail = await getConversationDetail(page, conversationId);
	const validSnapshots = (detail.contextCompressionSnapshots ?? []).filter(
		(snapshot) => snapshot.status === "valid",
	);
	steps.push({
		name: "persisted valid snapshots",
		ok: validSnapshots.length >= 3,
		notes: [`validSnapshots=${validSnapshots.length}`],
	});

	if (!keepConversations) {
		await apiJson(
			page,
			`/api/conversations/${encodeURIComponent(conversationId)}`,
			{
				method: "DELETE",
			},
		);
	}

	return {
		label,
		model,
		conversationId,
		keptConversation: keepConversations,
		steps,
		screenshots,
		ok: steps.every((step) => step.ok),
	};
}

async function runAutomaticLowContextPass(
	page: Page,
	model: ModelRef,
	label: string,
) {
	const steps: SweepStep[] = [];
	const title = `live-ai-sweep auto-low-context ${label} ${new Date().toISOString()}`;
	const conversationId = await createConversation(page, title);
	await refreshConversationPage(page, conversationId);
	const screenshots: string[] = [
		await screenshot(page, label, "auto-low-context-start"),
	];

	return withLowContextSettings(page, model, async () => {
		const seed = await streamTurn(page, {
			conversationId,
			modelId: model.id,
			message: automaticCompactionSeedPrompt(label),
		});
		const seedLeaks = detectLeaks(seed.text, "general");
		steps.push({
			name: "automatic compaction seed turn",
			ok: seedLeaks.length === 0,
			notes:
				seedLeaks.length === 0 ? ["no leak signatures detected"] : seedLeaks,
			textLength: seed.text.length,
		});

		const followup = await streamTurn(page, {
			conversationId,
			modelId: model.id,
			message: automaticCompactionFollowupPrompt,
		});
		const followupLeaks = detectLeaks(followup.text, "general");
		steps.push({
			name: "automatic compaction overflow follow-up",
			ok: followupLeaks.length === 0,
			notes:
				followupLeaks.length === 0
					? ["no leak signatures detected"]
					: followupLeaks,
			textLength: followup.text.length,
		});

		const recall = await streamTurn(page, {
			conversationId,
			modelId: model.id,
			message: automaticCompactionRecallPrompt,
		});
		const recallLeaks = detectLeaks(recall.text, "general");
		const expectedRecallNeedles = [
			"AUTOCOMP-QUARTZ-93",
			"Nóra Varga",
			"Mályva-híd 12",
			"Kende Farkas",
			"90413.77",
			"6F",
			"Cobalt-8",
			"SILVER-MANGO-204",
			"Room 5D",
		];
		const missingRecallNeedles = expectedRecallNeedles.filter(
			(needle) => !recall.text.toLowerCase().includes(needle.toLowerCase()),
		);
		steps.push({
			name: "automatic compaction recall",
			ok: recallLeaks.length === 0 && missingRecallNeedles.length === 0,
			notes: [
				...(recallLeaks.length === 0
					? ["no leak signatures detected"]
					: recallLeaks),
				...(missingRecallNeedles.length === 0
					? ["all expected auto-pass needles found"]
					: [`missing: ${missingRecallNeedles.join(", ")}`]),
			],
			textLength: recall.text.length,
		});
		await writeFile(
			path.join(outputDir, `${slug(label)}-auto-low-context-recall.json`),
			JSON.stringify(recall, null, 2),
		);

		const detail = await getConversationDetail(page, conversationId);
		const snapshots = detail.contextCompressionSnapshots ?? [];
		const validAutomaticSnapshots = snapshots.filter(
			(snapshot) =>
				snapshot.status === "valid" && snapshot.trigger === "automatic",
		);
		const metadataSnapshots = [
			...(((seed.metadata?.contextCompressionSnapshots as
				| Array<Record<string, unknown>>
				| undefined) ?? []) as Array<Record<string, unknown>>),
			...(((followup.metadata?.contextCompressionSnapshots as
				| Array<Record<string, unknown>>
				| undefined) ?? []) as Array<Record<string, unknown>>),
			...(((recall.metadata?.contextCompressionSnapshots as
				| Array<Record<string, unknown>>
				| undefined) ?? []) as Array<Record<string, unknown>>),
		];
		const metadataAutomaticSnapshots = metadataSnapshots.filter(
			(snapshot) =>
				snapshot.status === "valid" && snapshot.trigger === "automatic",
		);
		steps.push({
			name: "automatic compaction snapshot",
			ok:
				validAutomaticSnapshots.length > 0 ||
				metadataAutomaticSnapshots.length > 0,
			notes: [
				`detailAutomaticSnapshots=${validAutomaticSnapshots.length}`,
				`metadataAutomaticSnapshots=${metadataAutomaticSnapshots.length}`,
				`allSnapshots=${snapshots.length}`,
			],
		});

		await refreshConversationPage(page, conversationId);
		screenshots.push(await screenshot(page, label, "auto-low-context-final"));

		if (!keepConversations) {
			await apiJson(
				page,
				`/api/conversations/${encodeURIComponent(conversationId)}`,
				{
					method: "DELETE",
				},
			);
		}

		return {
			label: `${label}-auto-low-context`,
			model,
			conversationId,
			lowContextPass,
			keptConversation: keepConversations,
			steps,
			screenshots,
			ok: steps.every((step) => step.ok),
		};
	});
}

async function main() {
	requireEnv("LIVE_AI_EMAIL", email);
	requireEnv("LIVE_AI_PASSWORD", password);
	assertValidLowContextPassConfig();
	await mkdir(outputDir, { recursive: true });

	const browser = await chromium.launch({ headless });
	const context = await browser.newContext({
		baseURL: baseUrl,
		viewport: { width: 1440, height: 1200 },
	});
	const page = await context.newPage();

	try {
		await login(page);
		const models = [];
		for (const target of modelTargets) {
			models.push({ target, model: await resolveModel(page, target) });
		}

		const results = [];
		for (const { target, model } of models) {
			const standard = await runModelSweep(page, model, target.label);
			const automaticLowContext = await runAutomaticLowContextPass(
				page,
				model,
				target.label,
			);
			results.push({
				...standard,
				automaticLowContext,
				ok: standard.ok && automaticLowContext.ok,
			});
		}

		const summary = {
			baseUrl,
			outputDir,
			createdAt: new Date().toISOString(),
			results,
			ok: results.every((result) => result.ok),
		};
		await writeFile(
			path.join(outputDir, "summary.json"),
			JSON.stringify(summary, null, 2),
		);
		console.log(JSON.stringify(summary, null, 2));
		if (!summary.ok) {
			process.exitCode = 1;
		}
	} finally {
		await context.close();
		await browser.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
