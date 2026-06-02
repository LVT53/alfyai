// src/lib/server/services/title-generator.ts
import { getConfig } from "../config-store";
import { normalizeAssistantOutput } from "./chat-turn/normalizer";

// Common misspellings dictionary for post-processing correction
const COMMON_MISSPELLINGS: Record<string, string> = {
	humantizing: "humanizing",
	humantize: "humanize",
	humantized: "humanized",
	recieve: "receive",
	recieved: "received",
	seperate: "separate",
	seperated: "separated",
	occured: "occurred",
	occurance: "occurrence",
	definately: "definitely",
	accomodate: "accommodate",
	acheive: "achieve",
	beleive: "believe",
	calender: "calendar",
	collegue: "colleague",
	concious: "conscious",
	existance: "existence",
	goverment: "government",
	independant: "independent",
	maintainance: "maintenance",
	neccessary: "necessary",
	noticable: "noticeable",
	occassion: "occasion",
	paralell: "parallel",
	persistant: "persistent",
	posession: "possession",
	prefered: "preferred",
	proffesional: "professional",
	publically: "publicly",
	recomend: "recommend",
	refering: "referring",
	relevent: "relevant",
	succesful: "successful",
	supercede: "supersede",
	tommorow: "tomorrow",
	untill: "until",
	wich: "which",
};

// Hungarian-specific characters and common words for language detection
const HUNGARIAN_CHARS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/;
// Strong indicators - words that are distinctly Hungarian (not common English words)
const STRONG_HUNGARIAN_WORDS =
	/\b(és|hogy|nem|van|meg|ez|egy|kell|azt|volt)\b/i;

// Code-related keywords and patterns
const CODE_PATTERNS = [
	/```[\s\S]*?```/, // Code blocks
	/`[^`]+`/, // Inline code
	/\b(function|class|import|export|const|let|var|def|if|for|while|return)\b/,
	/\b(console|print|log|error|debug)\b/,
	/\b(html|css|javascript|python|java|typescript|react|vue|svelte)\b/i,
];

// Thinking/chain-of-thought patterns that indicate the model leaked its
// reasoning process into the visible output. When a model does not respect
// `enable_thinking: false`, it may output planning text such as
// "Here's a thinking process: 1. **Analyze User Input:** ..." as plain
// text in the content field.  These patterns never describe valid titles.
const THINKING_LEAK_RE =
	/^(Here's (a thinking|my) process|Let me (think about|work through|break (this|it) down)|I('ll| will) (approach|break (this|it) down)|First,? let me (think|analyze|break down)|Okay,? let me (think|analyze|work through)|Let's think about|I need to (think|determine)|The user (is asking|asks|asked)|This (looks like|seems like|is a)|Hmm,? let me|Alright,? let me)/i;

function detectLanguage(text: string): "en" | "hu" {
	if (HUNGARIAN_CHARS.test(text)) {
		return "hu";
	}
	const strongMatches = text.match(STRONG_HUNGARIAN_WORDS);
	if (strongMatches && strongMatches.length >= 2) {
		return "hu";
	}
	return "en";
}

const EXPLICIT_ENGLISH_HINT_RE =
	/\b(in english|english title|respond in english|answer in english)\b|angolul/i;
const EXPLICIT_HUNGARIAN_HINT_RE =
	/\b(in hungarian|hungarian title|respond in hungarian|answer in hungarian)\b|magyarul/i;

function resolveTitleLanguage(
	userMessage: string,
	userPreference?: "auto" | "en" | "hu",
): "en" | "hu" {
	if (userPreference === "en") return "en";
	if (userPreference === "hu") return "hu";
	if (EXPLICIT_ENGLISH_HINT_RE.test(userMessage)) return "en";
	if (EXPLICIT_HUNGARIAN_HINT_RE.test(userMessage)) return "hu";
	return detectLanguage(userMessage);
}

/**
 * Check if the conversation is code-related
 * @param userMessage The user's message
 * @param assistantResponse The assistant's response
 * @returns true if code-related
 */
function isCodeRelated(
	userMessage: string,
	assistantResponse: string,
): boolean {
	const combinedText = `${userMessage} ${assistantResponse}`;
	return CODE_PATTERNS.some((pattern) => pattern.test(combinedText));
}

/**
 * Correct common misspellings in the title
 * @param title The title to correct
 * @returns Title with corrected spellings
 */
function correctSpelling(title: string): string {
	if (!title || typeof title !== "string") {
		return title;
	}

	// Split into words and correct each one
	return title
		.split(/\s+/)
		.map((word) => {
			// Check for exact match (case-insensitive)
			const lowerWord = word.toLowerCase();
			if (COMMON_MISSPELLINGS[lowerWord]) {
				// Preserve original capitalization pattern
				if (word === word.toUpperCase()) {
					return COMMON_MISSPELLINGS[lowerWord].toUpperCase();
				} else if (word[0] === word[0]?.toUpperCase()) {
					return (
						COMMON_MISSPELLINGS[lowerWord].charAt(0).toUpperCase() +
						COMMON_MISSPELLINGS[lowerWord].slice(1)
					);
				}
				return COMMON_MISSPELLINGS[lowerWord];
			}
			return word;
		})
		.join(" ");
}

/**
 * Clean and normalize the generated title
 * - Removes surrounding quotes
 * - Removes prefixes like "Title:" or "Conversation:"
 * - Removes trailing periods
 * - Corrects common misspellings
 * - Trims whitespace
 * @param title The raw title from the model
 * @returns Cleaned title
 */
function cleanTitle(title: string): string {
	if (!title || typeof title !== "string") {
		return "";
	}

	let cleaned = title.trim();

	// Remove surrounding quotes (single and double)
	cleaned = cleaned.replace(/^["']+|["']+$/g, "");

	// Remove common prefixes (case-insensitive)
	const prefixes = [
		/^title[:\s-]+/i,
		/^conversation[:\s-]+/i,
		/^chat[:\s-]+/i,
		/^topic[:\s-]+/i,
		/^subject[:\s-]+/i,
		/^cím[:\s-]+/i,
		/^beszélgetés[:\s-]+/i,
	];

	for (const prefix of prefixes) {
		cleaned = cleaned.replace(prefix, "");
	}

	// Remove trailing periods (but keep other punctuation)
	cleaned = cleaned.replace(/\.+$/, "");

	// Trim again after all replacements
	cleaned = cleaned.trim();

	// Apply spell correction
	cleaned = correctSpelling(cleaned);

	return cleaned;
}

/**
 * Detect whether the raw text looks like leaked thinking/reasoning content
 * rather than a genuine title.  Some models do not respect
 * `enable_thinking: false` and emit their chain-of-thought as plain text.
 */
function isThinkingLeak(text: string): boolean {
	return THINKING_LEAK_RE.test(text.trim());
}

function isPlausibleTitle(text: string): boolean {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return false;
	if (normalized.length > 100) return false;
	if (normalized.split(" ").filter(Boolean).length > 12) return false;
	return !isThinkingLeak(normalized);
}

/**
 * Generate a fallback title from the user message
 * @param userMessage The user's message
 * @returns A fallback title
 */
function fallbackTitle(userMessage: string): string {
	const normalized = userMessage.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return "New Conversation";
	}

	const words = normalized.split(" ").slice(0, 8);
	return words.join(" ");
}

/**
 * Build few-shot examples for the prompt
 * @param language The detected language ('en' or 'hu')
 * @param isCodeRelated Whether the conversation is code-related
 * @returns Array of example messages
 */
function buildFewShotExamples(
	language: "en" | "hu",
	isCodeRelated: boolean,
): Array<{ role: "user" | "assistant"; content: string }> {
	if (language === "hu") {
		const examples = [
			{
				user: "Hogyan tudok React komponenst létrehozni?",
				assistant:
					"A React komponensek funkcionális komponensek vagy osztályok formájában hozhatók létre...",
				title: "React komponens létrehozási alapok",
			},
			{
				user: "Mi a különbség a let és const között?",
				assistant:
					"A let változó deklarálására szolgál, amelynek értéke megváltoztatható...",
				title: "Let és const használati különbségek",
			},
			{
				user: "Segítség a Python függvényekkel",
				assistant: "A Python függvények a def kulcsszóval definiálhatók...",
				title: "Python függvények gyakorlati áttekintése",
			},
			{
				user: "Szeretnék tanácsot adatbázis tervezéshez",
				assistant:
					"Az adatbázis tervezésnél fontos a normalizálás és a kapcsolatok...",
				title: "Adatbázis tervezési tanácsok kezdéshez",
			},
		];

		return examples.flatMap((ex) => [
			{
				role: "user" as const,
				content: `User: ${ex.user}\nAssistant: ${ex.assistant}`,
			},
			{ role: "assistant" as const, content: ex.title },
		]);
	} else {
		const examples = [
			{
				user: "How do I create a React component?",
				assistant:
					"React components can be created as functional components or classes...",
				title: "How to Create React Components",
			},
			{
				user: "What's the difference between let and const?",
				assistant:
					"let is used for variable declarations that can be reassigned...",
				title: "Key Differences Between Let and Const",
			},
			{
				user: "Help with Python functions",
				assistant: "Python functions are defined using the def keyword...",
				title: "Help With Python Function Basics",
			},
			{
				user: "I need advice on database design",
				assistant:
					"Database design involves normalization and establishing relationships...",
				title: "Practical Database Design Advice",
			},
		];

		// Add code-specific example if code-related
		if (isCodeRelated) {
			examples.push({
				user: "How do I fix this JavaScript error?",
				assistant:
					"The error occurs because you are trying to access a property of undefined...",
				title: "Debugging a JavaScript Undefined Error",
			});
		}

		return examples.flatMap((ex) => [
			{
				role: "user" as const,
				content: `User: ${ex.user}\nAssistant: ${ex.assistant}`,
			},
			{ role: "assistant" as const, content: ex.title },
		]);
	}
}

function buildTitleMessages(
	systemPrompt: string,
	language: "en" | "hu",
	isCodeRelated: boolean,
	userMessage: string,
	assistantResponse: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
	const messages: Array<{
		role: "system" | "user" | "assistant";
		content: string;
	}> = [];

	if (systemPrompt.trim()) {
		messages.push({ role: "system", content: systemPrompt.trim() });
	}

	return [
		...messages,
		...buildFewShotExamples(language, isCodeRelated),
		{
			role: "user",
			content: `Return only a concise conversation title, 3-8 words, with no explanation.\nUser: ${userMessage}\nAssistant: ${assistantResponse.slice(0, 200)}`,
		},
	];
}

function resolveConfiguredTitleSystemPrompt(
	language: "en" | "hu",
	isCodeRelated: boolean,
): string {
	const config = getConfig();
	const basePrompt =
		language === "hu"
			? config.titleGenSystemPromptHu
			: config.titleGenSystemPromptEn;
	const codeAppendix =
		language === "hu"
			? config.titleGenSystemPromptCodeAppendixHu
			: config.titleGenSystemPromptCodeAppendixEn;

	return [basePrompt.trim(), isCodeRelated ? codeAppendix.trim() : ""]
		.filter(Boolean)
		.join("\n");
}

function buildTitleRequestBody(params: {
	model: string;
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
	temperature: number;
	includeVllmThinkingControls?: boolean;
}): Record<string, unknown> {
	const qwenThinkingOff = { enable_thinking: false };
	const body: Record<string, unknown> = {
		model: params.model,
		messages: params.messages,
		max_tokens: 120,
		temperature: params.temperature,
	};

	if (params.includeVllmThinkingControls !== false) {
		// vLLM exposes chat_template_kwargs as a request field. The OpenAI client
		// spelling is kept too for compatible proxies that unpack extra_body.
		body.chat_template_kwargs = qwenThinkingOff;
		body.extra_body = { chat_template_kwargs: qwenThinkingOff };
	}

	return body;
}

async function fetchTitleCompletion(params: {
	url: string;
	headers: Record<string, string>;
	model: string;
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
	temperature: number;
	includeVllmThinkingControls?: boolean;
}): Promise<Response> {
	return fetch(`${params.url}/chat/completions`, {
		method: "POST",
		headers: params.headers,
		body: JSON.stringify(
			buildTitleRequestBody({
				model: params.model,
				messages: params.messages,
				temperature: params.temperature,
				includeVllmThinkingControls: params.includeVllmThinkingControls,
			}),
		),
	});
}

export async function generateTitle(
	userMessage: string,
	assistantResponse: string,
	titleLanguage?: "auto" | "en" | "hu",
): Promise<string> {
	const config = getConfig();
	const language = resolveTitleLanguage(userMessage, titleLanguage);
	const codeRelated = isCodeRelated(userMessage, assistantResponse);
	const systemPrompt = resolveConfiguredTitleSystemPrompt(
		language,
		codeRelated,
	);

	console.info("[TITLE_GENERATE] Resolved generation params", {
		requestedLanguage: titleLanguage,
		resolvedLanguage: language,
		codeRelated,
		hasSystemPrompt: systemPrompt.trim().length > 0,
	});

	const messages = buildTitleMessages(
		systemPrompt,
		language,
		codeRelated,
		userMessage,
		assistantResponse,
	);

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.titleGenApiKey)
		headers.Authorization = `Bearer ${config.titleGenApiKey}`;

	let response = await fetchTitleCompletion({
		url: config.titleGenUrl,
		headers,
		model: config.titleGenModel,
		messages,
		temperature: 0.2,
	});
	if (response.status === 400) {
		console.info(
			"[TITLE_GENERATE] Retrying with strict OpenAI-compatible request body",
		);
		response = await fetchTitleCompletion({
			url: config.titleGenUrl,
			headers,
			model: config.titleGenModel,
			messages,
			temperature: 0.2,
			includeVllmThinkingControls: false,
		});
	}

	if (!response.ok) {
		throw new Error(`Title generation failed: ${response.status}`);
	}

	const json = await response.json();
	const choice = json.choices?.[0]?.message;
	const rawContent =
		typeof choice?.content === "string" ? choice.content.trim() : "";
	const rawTitle = normalizeAssistantOutput(rawContent);

	if (!rawTitle || !isPlausibleTitle(rawTitle)) {
		console.info("[TITLE_GENERATE] Fallback: empty rawTitle or thinking leak");
		return fallbackTitle(userMessage);
	}
	const cleanedTitle = cleanTitle(rawTitle);
	if (!isPlausibleTitle(cleanedTitle)) {
		console.info("[TITLE_GENERATE] Fallback: empty cleanedTitle");
		return fallbackTitle(userMessage);
	}
	const detectedLang = detectLanguage(cleanedTitle);
	if (detectedLang !== language) {
		console.info("[TITLE_GENERATE] Fallback: language mismatch", {
			expected: language,
			detected: detectedLang,
			cleanedTitle,
		});
		return fallbackTitle(userMessage);
	}

	return cleanedTitle;
}
