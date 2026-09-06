// Verification aid: log the SHAPE of an outbound model call (roles, part
// types, token estimates) without any content. Enabled by
// NORMAL_CHAT_DEBUG_OUTBOUND=1; off in normal operation.

import { createHash } from "node:crypto";

import type { ModelMessage } from "ai";
import { getConfig } from "$lib/server/config-store";
import { estimateTokenCount } from "$lib/utils/tokens";

function describeMessage(message: ModelMessage): string {
	if (typeof message.content === "string") {
		return `${message.role}(text≈${estimateTokenCount(message.content)})`;
	}
	const parts = message.content.map((part) => {
		switch (part.type) {
			case "text":
				return `text≈${estimateTokenCount(part.text)}`;
			case "tool-call":
				return `tool-call:${part.toolName}`;
			case "tool-result":
				return `tool-result:${part.toolName}≈${estimateTokenCount(
					JSON.stringify(part.output),
				)}`;
			default:
				return part.type;
		}
	});
	return `${message.role}[${parts.join(",")}]`;
}

export function logOutboundMessageShape(params: {
	label: string;
	systemPrompt?: string;
	messages: ModelMessage[];
	toolCount: number;
}): void {
	if (!getConfig().normalChatDebugOutbound) return;
	const systemTokens = params.systemPrompt
		? estimateTokenCount(params.systemPrompt)
		: 0;
	// Hashes make prefix-cache breakage visible: the system prompt must be
	// identical from turn to turn for the provider to reuse its prefill.
	const systemHash = params.systemPrompt
		? createHash("sha1").update(params.systemPrompt).digest("hex").slice(0, 10)
		: null;
	console.log("[OUTBOUND]", {
		label: params.label,
		systemTokens,
		systemHash,
		toolCount: params.toolCount,
		messageCount: params.messages.length,
		messages: params.messages.map(describeMessage),
	});
}
