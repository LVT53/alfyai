import {
	createInlineThinkingState,
	flushInlineThinkingState,
	processInlineThinkingChunk,
	splitLeadingThinkingPreamble,
	stripLeadingResponseMarker,
	stripLeakedToolDiagnostics,
} from "$lib/services/stream-protocol";
import { sanitizeNormalChatAnswer } from "$lib/shared/normal-chat-output";
import { parseSkillControlEnvelopeFromAssistantText } from "./skill-control-envelope";

/**
 * Canonical text normalization for assistant output.
 * Strips thinking content, tool-call markers, and leading provider markers.
 * Used by both send and stream paths.
 */
export function normalizeAssistantOutput(text: string): string {
	return normalizeAssistantOutputWithSkillControl(text).visibleText;
}

export function normalizeAssistantOutputWithSkillControl(
	text: string,
	options: { skillControlEnabled?: boolean; structuredOutput?: boolean } = {},
) {
	if (!text) return { visibleText: "", operations: [] };

	const split = options.structuredOutput
		? null
		: splitLeadingThinkingPreamble(text, { allowOpenEnded: true });
	const inputText = options.structuredOutput
		? text
		: split
			? split.visibleText
			: stripLeadingResponseMarker(text);

	const state = createInlineThinkingState();
	let visibleText = "";

	processInlineThinkingChunk(state, inputText, {
		onVisible(chunk) {
			visibleText += chunk;
		},
		onThinking() {},
	});
	flushInlineThinkingState(state, {
		onVisible(chunk) {
			visibleText += chunk;
		},
		onThinking() {},
	});

	if (options.structuredOutput) {
		const parsed =
			options.skillControlEnabled === false
				? { visibleText, operations: [] }
				: parseSkillControlEnvelopeFromAssistantText(visibleText);
		return {
			...parsed,
			visibleText: stripLeakedToolDiagnostics(
				sanitizeNormalChatAnswer(parsed.visibleText),
				undefined,
				{ leading: false, final: true },
			),
		};
	}

	if (options.skillControlEnabled === false) {
		return {
			visibleText: stripLeakedToolDiagnostics(visibleText, undefined, {
				final: true,
			}).trim(),
			operations: [],
		};
	}

	// The envelope is read from the text as the model wrote it and only what
	// is left is cleaned, the order the stream runtime uses: the leaked-output
	// cleanup would otherwise edit the skill's own words.
	const parsed = parseSkillControlEnvelopeFromAssistantText(visibleText);
	return {
		...parsed,
		visibleText: stripLeakedToolDiagnostics(parsed.visibleText, undefined, {
			final: true,
		}).trim(),
	};
}
