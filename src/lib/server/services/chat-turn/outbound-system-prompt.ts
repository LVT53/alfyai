import { stripDeprecatedPromptSections } from "../../prompts";
import type { ResolvedTurnInstructions } from "../instructions";
import type { ReasoningDepthEffort } from "./reasoning-depth-effort";

const GPT_OSS_HIGH_REASONING_DIRECTIVE = "Reasoning: high";
const GPT_OSS_REASONING_DIRECTIVE_RE =
	/(^|\n)Reasoning:\s*(?:low|medium|high)\s*(?=\n|$)/i;
const GPT_OSS_REASONING_DIRECTIVE_LINE_RE =
	/^\s*Reasoning:\s*(?:low|medium|high)\s*$/i;

// Redesign R8 — concise holistic framing for the connection tools
// (calendar/files/email/photos/media/location/contacts). Only spliced into
// the outbound system prompt when the caller reports the user has at least
// one active connection capability (buildOutboundSystemPrompt's
// `hasActiveConnections`), so turns with no connections don't pay the token
// cost. Deliberately English-only, matching every other guard constant in
// this file — the model is instructed in English whatever the person writes,
// and the language of its reply is the model's to choose under
// REPLY_LANGUAGE_RULE (spliced into buildTurnGuidance).
const CONNECTIONS_FRAMING_GUARD = [
	"Connected Accounts:",
	"- The user may have connected personal accounts (calendar, files, email, photos, media, location, contacts). Use the relevant connection tool when the user's request calls for it. Do not announce tool use mechanically, and only surface connected-account data when it is relevant to the request.",
	"- Every write to a connected account — creating/updating/deleting a calendar event, saving a file, sending/trashing/flagging an email, adding photos to an album — is only a proposal. You never modify a connected account immediately or autonomously; the user must explicitly confirm before anything is written.",
	"- If more than one connected account could serve a request (e.g. two calendars), ask the user which one to use, unless the conversation or memory already makes it clear.",
].join("\n");

// R1 defect 5 — this generic tool-call-JSON-formatting guidance was dropped
// entirely by G1 (ADR-0055, which deleted the message-content-selected
// guidance-pack machinery this used to ride on). It applies to every tool
// call regardless of which specific tool is used, so — unlike the
// per-tool when/how/example guidance G1 correctly relocated onto each
// tool's own TOOL_TEXT description — it belongs here as always-on runtime
// guidance, gated only on tools actually being available (the same
// `!skipDefaultRuntimeGuidance` gate the other default runtime guidance
// below uses; the tool-less control-model caller is the only caller that
// opts out). Per the P2 prompt-diet review outcomes, this is NOT a
// per-turn conditional (it does not vary with message content or with
// what tools are in play) — it is always-on for any tool-bearing caller,
// which keeps the static system-message prefix stable across turns.
// Deliberately English-only, matching every other guard constant in this
// file. Kept to roughly 450 chars — see prompts.ts's `## Tools` section for
// the tool-usage policy this pairs with.
const JSON_FORMATTING_RULES = [
	"Tool JSON formatting rules — all tool arguments MUST be valid JSON:",
	"- Pass exactly the JSON object with no trailing punctuation after the closing `}`; the argument ends there. Use `\\n` for newlines inside JSON strings; only schema fields.",
	"- Do not add comments, markdown fences, or explanatory text inside the JSON argument.",
	"- On a parse error, read the message, fix the specific issue, and retry once. Do not repeat the same malformed JSON.",
].join("\n");

// P2 prompt-diet review outcome — the personality/"Response Style" prompt is
// admin/user-authored free text with no upstream length limit; cap it here so
// a runaway personality prompt cannot blow out the static system-message
// prefix. The ellipsis marker makes truncation visible to anyone inspecting
// the assembled prompt rather than silently clipping mid-sentence.
const MAX_PERSONALITY_PROMPT_CHARS = 1_500;
const PERSONALITY_PROMPT_ELLIPSIS_MARKER = "\n\n… [truncated]";

function capPersonalityPrompt(personalityPrompt: string): string {
	if (personalityPrompt.length <= MAX_PERSONALITY_PROMPT_CHARS) {
		return personalityPrompt;
	}
	const budget =
		MAX_PERSONALITY_PROMPT_CHARS - PERSONALITY_PROMPT_ELLIPSIS_MARKER.length;
	return (
		personalityPrompt.slice(0, Math.max(0, budget)) +
		PERSONALITY_PROMPT_ELLIPSIS_MARKER
	);
}

function isGptOssModel(modelName: string): boolean {
	return /\bgpt(?:[-_\s]?oss)\b/i.test(modelName);
}

function stripGptOssReasoningDirectives(basePromptBody: string): string {
	return basePromptBody
		.split("\n")
		.filter((line) => !GPT_OSS_REASONING_DIRECTIVE_LINE_RE.test(line))
		.join("\n")
		.trim();
}

function resolveGptOssReasoningDirective(params: {
	needsGptOssReasoningDirective: boolean;
	reasoningDepthEffort?: ReasoningDepthEffort;
}): "high" | "none" | null {
	if (!params.needsGptOssReasoningDirective) {
		return null;
	}
	const effort = params.reasoningDepthEffort;
	if (
		effort?.providerReasoning.thinkingMode === "off" ||
		effort?.depthMetadata.appliedProfile === "off"
	) {
		return "none";
	}
	return "high";
}

export function buildOutboundSystemPrompt(params: {
	basePrompt: string;
	inputValue: string;
	modelDisplayName?: string;
	modelName?: string;
	systemPromptAppendix?: string;
	personalityPrompt?: string;
	// The turn's standing guidance, already resolved by the caller
	// (resolveTurnInstructions). Optional so every existing caller — including
	// the control-model path — keeps compiling and rendering nothing.
	instructions?: ResolvedTurnInstructions | null;
	forceWebSearch?: boolean;
	reasoningDepthEffort?: ReasoningDepthEffort;
	// When true, omits every turn-scoped guidance addition below (temporal
	// anchor, response-language guard, reasoning-depth contract) — used by
	// the control-model JSON caller, which has no tools and wants the
	// leanest possible system prompt. CONNECTIONS_FRAMING_GUARD and
	// systemPromptAppendix are NOT gated by this flag; they always apply
	// when their own trigger condition is met.
	skipDefaultRuntimeGuidance?: boolean;
	// Redesign R8 — true when the caller resolved at least one active
	// connection capability for this turn (see activeConnectionCapabilities
	// on PrepareOutboundChatContextParams). Splices CONNECTIONS_FRAMING_GUARD
	// into the prompt so a connections-enabled turn always carries the
	// confirm-before-write framing, even before any connection tool is
	// actually called.
	hasActiveConnections?: boolean;
}): string {
	const modelHeader = params.modelDisplayName
		? `[MODEL: ${params.modelDisplayName}]`
		: "";
	const needsGptOssReasoningDirective = [
		params.modelName,
		params.modelDisplayName,
	].some((value) => typeof value === "string" && isGptOssModel(value));
	const basePromptBody = params.basePrompt.trim();
	const gptOssReasoningDirective = resolveGptOssReasoningDirective({
		needsGptOssReasoningDirective,
		reasoningDepthEffort: params.reasoningDepthEffort,
	});
	let normalizedBasePromptBody = basePromptBody;
	if (gptOssReasoningDirective === "none") {
		normalizedBasePromptBody = stripGptOssReasoningDirectives(basePromptBody);
	} else if (
		gptOssReasoningDirective === "high" &&
		GPT_OSS_REASONING_DIRECTIVE_RE.test(basePromptBody)
	) {
		normalizedBasePromptBody = basePromptBody.replace(
			GPT_OSS_REASONING_DIRECTIVE_RE,
			`$1${GPT_OSS_HIGH_REASONING_DIRECTIVE}`,
		);
	}
	const promptPreamble =
		gptOssReasoningDirective === "high" &&
		!GPT_OSS_REASONING_DIRECTIVE_RE.test(normalizedBasePromptBody)
			? GPT_OSS_HIGH_REASONING_DIRECTIVE
			: "";
	const basePrompt = [modelHeader, promptPreamble, normalizedBasePromptBody]
		.filter(Boolean)
		.join("\n\n");
	// Only text that is identical from turn to turn belongs in the system
	// message: the provider's prefix cache reuses prefill work only while the
	// request is byte-for-byte the same as an earlier one, and the tool
	// catalogue (thousands of tokens) is rendered right after this message.
	// Anything that changes per turn — today's date, the response-language
	// guard derived from the latest message, the reasoning-depth contract —
	// goes into the user packet instead (buildTurnGuidance). Tool usage
	// guidance lives in each tool's own description (ADR-0055).
	const guidanceAdditions: string[] = params.skipDefaultRuntimeGuidance
		? []
		: [JSON_FORMATTING_RULES];

	if (params.hasActiveConnections) {
		guidanceAdditions.push(CONNECTIONS_FRAMING_GUARD);
	}

	if (
		typeof params.systemPromptAppendix === "string" &&
		params.systemPromptAppendix.trim()
	) {
		guidanceAdditions.push(params.systemPromptAppendix.trim());
	}

	const uniqueGuidance = Array.from(new Set(guidanceAdditions));
	const sections: string[] = [];

	if (basePrompt) {
		sections.push(basePrompt);
	}

	if (uniqueGuidance.length > 0) {
		sections.push(`## Runtime Guidance\n${uniqueGuidance.join("\n\n")}`);
	}

	if (params.personalityPrompt?.trim()) {
		sections.push(
			[
				"## Response Style",
				"Apply this style strictly to every visible response. It overrides your default structure, length, formatting, and voice. Treat it as a hard rule, not a soft preference. Before finalizing, revise the answer to match the selected style's length, format, and prose constraints. Deviate whenever it conflicts with safety, tool or source-citation requirements, with the user's instructions (project instructions first, then personal instructions), or with the current message.",
				capPersonalityPrompt(params.personalityPrompt.trim()),
			].join("\n"),
		);
	}

	const stripped = stripDeprecatedPromptSections(sections.join("\n\n"));

	// Instruction sections are appended AFTER stripping, never pushed into
	// `sections`: stripDeprecatedPromptSections deletes any paragraph holding a
	// deprecated-protocol token, and the instructions are the one part of this
	// prompt the user typed. Indentation keeps a user's own `## …` line from
	// becoming section structure; only the ordering keeps their text.
	// The project block follows the personal one, so the precedence the two
	// framings describe is also the order the model reads them in. Both are
	// rendered from the turn's resolved instructions alone — nothing about the
	// user packet, the latency tier or the conversation's memory state takes
	// part — which is what keeps them present on shallow and incognito turns.
	const instructionSections: string[] = [];
	if (params.instructions?.personal) {
		instructionSections.push(
			buildInstructionSection(
				"Your Instructions",
				INSTRUCTIONS_FRAMING,
				params.instructions.personal,
			),
		);
	}
	if (params.instructions?.project) {
		instructionSections.push(
			buildInstructionSection(
				"Project Instructions",
				PROJECT_INSTRUCTIONS_FRAMING,
				params.instructions.project.text,
			),
		);
	}

	return instructionSections.length > 0
		? `${stripped}\n\n${instructionSections.join("\n\n")}`
		: stripped;
}

const INSTRUCTIONS_FRAMING =
	"AlfyAI follows these in every chat. Follow Project Instructions over Your Instructions, and both over the Response Style and any remembered preference; the user's current message overrides all of them.";

// The project block's own framing, for the same reason the personal one has
// one: the model has to be told which standing guidance wins when the project
// and the account disagree. It names the scopes it outranks rather than
// saying "these" alone, because a project block can arrive with no personal
// block above it.
const PROJECT_INSTRUCTIONS_FRAMING =
	"AlfyAI follows these in every chat in this project. They take priority over your personal instructions, your memory and the Response Style; the user's current message overrides all of them.";

// Local to prompt assembly: it exists to put the user's text into the system
// message without letting its shape become part of the prompt's own structure.
// The user's text is never rewritten, escaped or sanitised — the four-space
// indent is the whole transformation, and it protects against the section
// *shape* only (the ordering above protects the text itself).
function buildInstructionSection(
	heading: string,
	framing: string,
	text: string,
): string {
	const indented = text
		.split("\n")
		.map((line) => (line.trim().length > 0 ? `    ${line}` : ""))
		.join("\n");

	return [`## ${heading}`, framing, indented].join("\n\n");
}
