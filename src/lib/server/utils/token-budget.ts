import { estimateTokenCount } from "$lib/utils/tokens";
import type { PromptContextSection } from "./prompt-context";

export type BuildContextPacketParams = {
	systemPrompt: string;
	historySections: PromptContextSection[];
	docSections: PromptContextSection[];
	userMessage: string;
	totalBudget: number;
	targetBudget?: number;
};

export type BuildContextPacketResult = {
	inputValue: string;
	estimatedTokens: number;
	compactionApplied: boolean;
};

export class TokenBudget {
	private remainingTokens: number;
	private slotUsage: Map<string, number>;

	constructor(totalBudget: number) {
		this.totalBudget = totalBudget;
		this.remainingTokens = totalBudget;
		this.slotUsage = new Map();
	}

	reserve(slot: string, text: string): void {
		const tokens = estimateTokenCount(text);
		const available = Math.min(tokens, this.remainingTokens);

		if (available > 0) {
			this.remainingTokens -= available;
		}

		this.slotUsage.set(slot, tokens);
	}

	remaining(): number {
		return this.remainingTokens;
	}

	remainingChars(): number {
		return this.remainingTokens * 4;
	}

	getSlotUsage(): Map<string, number> {
		return new Map(this.slotUsage);
	}
}

export function buildContextPacket(
	params: BuildContextPacketParams,
): BuildContextPacketResult {
	const {
		systemPrompt,
		historySections,
		docSections,
		userMessage,
		totalBudget,
		targetBudget,
	} = params;

	const budget = targetBudget ?? totalBudget;
	const budgetInstance = new TokenBudget(budget);

	const _systemTokens = estimateTokenCount(systemPrompt);
	budgetInstance.reserve("system", systemPrompt);

	const historyParts: string[] = [];
	for (const section of historySections) {
		const sectionText = section.body.trim();
		if (!sectionText) continue;

		const candidate = buildContextSection(section.title, sectionText);
		const candidateTokens = estimateTokenCount(candidate);

		if (budgetInstance.remaining() >= candidateTokens) {
			budgetInstance.reserve(`history:${section.title}`, candidate);
			historyParts.push(candidate);
		} else {
			break;
		}
	}

	const docParts: string[] = [];
	let compactionApplied = false;
	for (const section of docSections) {
		const sectionText = section.body.trim();
		if (!sectionText) continue;

		const candidate = buildContextSection(section.title, sectionText);
		const candidateTokens = estimateTokenCount(candidate);

		if (budgetInstance.remaining() >= candidateTokens) {
			budgetInstance.reserve(`doc:${section.title}`, candidate);
			docParts.push(candidate);
		} else {
			compactionApplied = true;
			break;
		}
	}

	const parts: string[] = [];
	if (systemPrompt.trim()) {
		parts.push(systemPrompt.trim());
	}
	if (historyParts.length > 0) {
		parts.push(...historyParts);
	}
	if (docParts.length > 0) {
		parts.push(...docParts);
	}
	if (userMessage.trim()) {
		parts.push(`## Current User Message\n${userMessage.trim()}`);
	}

	const inputValue = parts.join("\n\n");
	const estimatedTokens = estimateTokenCount(inputValue);

	return {
		inputValue,
		estimatedTokens,
		compactionApplied,
	};
}

function buildContextSection(title: string, body: string): string {
	return `## ${title}\n${body}`;
}
