import JSZip from "jszip";

export interface ChatGPTConversation {
	id: string;
	title: string;
	create_time: number;
	update_time: number;
	mapping: Record<string, ChatGPTMappingNode>;
	current_node: string | null;
	conversation_id: string;
	moderation_results: unknown[];
	plugin_ids: string[] | null;
	conversation_template_id: string | null;
	gizmo_id: string | null;
	gizmo_type: null;
	is_archived: boolean;
	is_starred: boolean | null;
	safe_urls: string[];
	default_model_slug: string | null;
	conversation_origin: null;
	voice: string | null;
	async_status: number | null;
	disabled_tool_ids: unknown[];
}

export interface ChatGPTMappingNode {
	id: string;
	message: ChatGPTMessage | null;
	parent: string | null;
	children: string[];
}

export interface ChatGPTMessage {
	id: string;
	author: ChatGPTAuthor;
	create_time: number | null;
	update_time: number | null;
	content: ChatGPTMessageContent;
	status: string;
	end_turn: boolean | null;
	weight: number;
	metadata: ChatGPTMessageMetadata;
	recipient: string;
	channel: null;
}

export interface ChatGPTAuthor {
	role: "system" | "user" | "assistant" | "tool";
	name: string | null;
	metadata: Record<string, unknown>;
}

export interface ChatGPTMessageMetadata {
	message_type?: string;
	model_slug?: string;
	default_model_slug?: string;
	parent_id?: string;
	request_id?: string;
	timestamp_?: string;
	is_complete?: boolean;
	is_visually_hidden_from_conversation?: boolean;
	[key: string]: unknown;
}

export type ChatGPTMessageContent =
	| ChatGPTTextContent
	| ChatGPTCodeContent
	| ChatGPTExecutionOutputContent
	| ChatGPTMultimodalTextContent
	| ChatGPTUserEditableContextContent
	| ChatGPTThoughtsContent
	| ChatGPTReasoningRecapContent
	| ChatGPTSystemErrorContent
	| Record<string, unknown>;

export interface ChatGPTTextContent {
	content_type: "text";
	parts: string[];
}

export interface ChatGPTCodeContent {
	content_type: "code";
	language: string;
	text: string;
}

export interface ChatGPTExecutionOutputContent {
	content_type: "execution_output";
	parts: string[];
}

export interface ChatGPTMultimodalTextContent {
	content_type: "multimodal_text";
	parts: (ChatGPTTextPart | ChatGPTImagePart | unknown)[];
}

export interface ChatGPTTextPart {
	content_type: "text";
	text: string;
}

export interface ChatGPTImagePart {
	content_type: "image_asset_pointer";
	asset_pointer: string;
	size_bytes: number;
	width: number;
	height: number;
	fovea: unknown;
	metadata: unknown;
}

export interface ChatGPTUserEditableContextContent {
	content_type: "user_editable_context";
	user_profile?: string;
	user_instructions?: string;
}

export interface ChatGPTThoughtsContent {
	content_type: "thoughts";
	thoughts: unknown[];
}

export interface ChatGPTReasoningRecapContent {
	content_type: "reasoning_recap";
	content: string;
}

export interface ChatGPTSystemErrorContent {
	content_type: "system_error";
	error_type?: string;
	code?: string;
	[key: string]: unknown;
}

export interface ParsedConversation {
	id: string;
	title: string;
	createdAt: Date;
	updatedAt: Date;
	model?: string;
	messages: ParsedMessage[];
	gizmoId: string | null;
	branches?: BranchInfo[];
}

export interface BranchInfo {
	/** ChatGPT UUID of the parent node where the active path and branch diverge */
	divergenceNodeId: string;
	/** ChatGPT UUID of the non-active child node that starts the branch */
	branchNodeId: string;
	/** Message weight of the branch node (typically < 1.0 for inactive branches) */
	weight: number;
	/** All messages in this branch from root to leaf (includes shared history) */
	messages: ParsedMessage[];
}

export interface ParsedMessage {
	role: "user" | "assistant" | "system";
	content: string;
	createdAt?: Date;
	metadata?: {
		model?: string;
		weight?: number;
	};
}

const UNICODE_CONTROL_RE = /[\ue200-\ue204]/g;

export function stripUnicodeControls(text: string): string {
	return text.replace(UNICODE_CONTROL_RE, "");
}

export function isDeletedMessage(message: ChatGPTMessage): boolean {
	const status = message.status?.toLowerCase() ?? "";
	if (
		status === "deleted" ||
		status === "hidden" ||
		status === "rejected" ||
		status === "cancelled"
	) {
		return true;
	}

	if (message.metadata?.is_visually_hidden_from_conversation) {
		return true;
	}

	return false;
}

export function extractContent(content: ChatGPTMessageContent): string | null {
	if (!content || typeof content !== "object") {
		return null;
	}

	const contentType: string | undefined = (content as Record<string, unknown>)
		.content_type as string | undefined;

	switch (contentType) {
		case "text": {
			const textContent = content as ChatGPTTextContent;
			if (!textContent.parts || !Array.isArray(textContent.parts)) return null;
			const joined = textContent.parts
				.filter((p): p is string => typeof p === "string")
				.join("\n");
			return stripUnicodeControls(joined);
		}

		case "code": {
			const codeContent = content as ChatGPTCodeContent;
			const lang = codeContent.language || "";
			const codeText = codeContent.text || "";
			return stripUnicodeControls(`\`\`\`${lang}\n${codeText}\n\`\`\``);
		}

		case "execution_output": {
			const execContent = content as ChatGPTExecutionOutputContent;
			if (!execContent.parts || !Array.isArray(execContent.parts)) return null;
			const joined = execContent.parts
				.filter((p): p is string => typeof p === "string")
				.join("\n");
			return stripUnicodeControls(joined);
		}

		case "multimodal_text": {
			const multiContent = content as ChatGPTMultimodalTextContent;
			if (!multiContent.parts || !Array.isArray(multiContent.parts))
				return null;
			const textParts = multiContent.parts
				.filter(
					(p): p is ChatGPTTextPart =>
						typeof p === "object" &&
						p !== null &&
						(p as Record<string, unknown>).content_type === "text",
				)
				.map((p) => (p as ChatGPTTextPart).text)
				.filter((t): t is string => typeof t === "string");
			return stripUnicodeControls(textParts.join(""));
		}

		case "user_editable_context":
			return null;

		case "thoughts":
			return null;

		case "reasoning_recap":
			return null;

		case "system_error":
			return null;

		default:
			return null;
	}
}

/**
 * Walk backward from `currentNodeId` via parent pointers.
 * Returns messages in chronological order (oldest first).
 */
export function reconstructThread(
	mapping: Record<string, ChatGPTMappingNode>,
	currentNodeId: string | null,
): ParsedMessage[] {
	const messages: ParsedMessage[] = [];

	if (!currentNodeId) {
		const fallbackId = findHighestWeightLeaf(mapping);
		if (!fallbackId) return messages;
		currentNodeId = fallbackId;
	}

	const nodeStack: ChatGPTMappingNode[] = [];
	let nodeId: string | null = currentNodeId;

	const visited = new Set<string>();
	while (nodeId) {
		if (visited.has(nodeId)) break;
		visited.add(nodeId);

		const node = mapping[nodeId];
		if (!node) break;

		nodeStack.push(node);
		nodeId = node.parent;
	}

	for (let i = nodeStack.length - 1; i >= 0; i--) {
		const node = nodeStack[i];

		if (!node.message) continue;

		const msg = node.message;

		if (isDeletedMessage(msg)) continue;

		if (msg.author.role === "system" || msg.author.role === "tool") {
			continue;
		}

		const content = extractContent(msg.content);
		if (content === null) continue;

		const trimmed = content.trim();
		if (trimmed.length === 0) continue;

		const role: "user" | "assistant" | "system" =
			msg.author.role === "user" ? "user" : "assistant";

		const parsedMsg: ParsedMessage = {
			role,
			content: trimmed,
			createdAt: msg.create_time ? new Date(msg.create_time * 1000) : undefined,
			metadata: {
				model: msg.metadata?.model_slug ?? msg.metadata?.default_model_slug,
				weight: msg.weight,
			},
		};

		messages.push(parsedMsg);
	}

	return messages;
}

/**
 * Find the highest-weight leaf node in the mapping.
 * Used as a fallback when current_node is missing.
 */
function findHighestWeightLeaf(
	mapping: Record<string, ChatGPTMappingNode>,
): string | null {
	let bestId: string | null = null;
	let bestWeight = -Infinity;

	for (const [id, node] of Object.entries(mapping)) {
		if (!node.message) continue;

		if (node.children.length > 0) continue;

		const weight = node.message.weight;
		if (weight > bestWeight) {
			bestWeight = weight;
			bestId = id;
		}
	}

	return bestId;
}

export interface ParseResult {
	conversations: ParsedConversation[];
	errors: ParseEntryError[];
}

export interface ParseEntryError {
	rawId?: string;
	rawTitle?: string;
	reason: string;
}

/**
 * Parse conversations from a ChatGPT export ZIP buffer.
 *
 * The ZIP must contain a `conversations.json` file at the root.
 * Returns parsed conversations and any per-entry errors encountered.
 */
export async function parseConversationsJson(
	zipBuffer: Buffer,
): Promise<ParseResult> {
	const conversations: ParsedConversation[] = [];
	const errors: ParseEntryError[] = [];

	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(zipBuffer);
	} catch (err) {
		errors.push({
			reason: `Failed to read ZIP: ${err instanceof Error ? err.message : "Unknown error"}`,
		});
		return { conversations, errors };
	}

	const jsonFile = zip.file("conversations.json");
	if (!jsonFile) {
		errors.push({
			reason:
				"No conversations.json found in the ZIP root. Ensure the file was exported as a ChatGPT data export.",
		});
		return { conversations, errors };
	}

	let raw: ChatGPTConversation[];
	try {
		const text = await jsonFile.async("text");
		raw = JSON.parse(text);
	} catch (err) {
		errors.push({
			reason: `Failed to parse conversations.json: ${err instanceof Error ? err.message : "Invalid JSON"}`,
		});
		return { conversations, errors };
	}

	if (!Array.isArray(raw)) {
		errors.push({
			reason:
				"conversations.json is not an array. Expected a ChatGPT export format.",
		});
		return { conversations, errors };
	}

	for (const entry of raw) {
		try {
			const parsed = parseSingleConversation(entry);
			if (parsed) {
				conversations.push(parsed);
			} else {
				errors.push({
					rawId: entry.id,
					rawTitle: entry.title,
					reason:
						"Conversation produced no messages after reconstruction (empty or all deleted).",
				});
			}
		} catch (err) {
			errors.push({
				rawId: entry.id,
				rawTitle: entry.title,
				reason: `Unexpected error: ${err instanceof Error ? err.message : "Unknown error"}`,
			});
		}
	}

	return { conversations, errors };
}

function findHighestWeightLeafInSubtree(
	mapping: Record<string, ChatGPTMappingNode>,
	startNodeId: string,
): string | null {
	let bestId: string | null = null;
	let bestWeight = -Infinity;

	const stack = [startNodeId];
	const visited = new Set<string>();

	while (stack.length > 0) {
		const currentId = stack.pop();
		if (!currentId || visited.has(currentId)) continue;
		visited.add(currentId);

		const node = mapping[currentId];
		if (!node) continue;

		if (node.children.length === 0) {
			if (node.message) {
				const weight = node.message.weight;
				if (weight > bestWeight) {
					bestWeight = weight;
					bestId = currentId;
				}
			}
		} else {
			stack.push(...node.children);
		}
	}

	return bestId;
}

export function detectBranches(
	mapping: Record<string, ChatGPTMappingNode>,
	current_node: string | null,
): BranchInfo[] {
	const branches: BranchInfo[] = [];
	if (!current_node) return branches;

	const activePathIds = new Set<string>();
	const activePathOrdered: string[] = [];
	let nodeId: string | null = current_node;
	const pathVisited = new Set<string>();
	while (nodeId) {
		if (pathVisited.has(nodeId)) break;
		pathVisited.add(nodeId);
		activePathIds.add(nodeId);
		activePathOrdered.unshift(nodeId);
		const node = mapping[nodeId];
		if (!node) break;
		nodeId = node.parent;
	}

	for (const parentId of activePathOrdered) {
		const parentNode = mapping[parentId];
		if (!parentNode || parentNode.children.length <= 1) continue;

		for (const childId of parentNode.children) {
			if (activePathIds.has(childId)) continue;

			const childNode = mapping[childId];
			if (!childNode) continue;

			const childWeight = childNode.message?.weight ?? 0;
			if (childWeight >= 1.0) continue;

			const branchLeafId = findHighestWeightLeafInSubtree(mapping, childId);
			if (!branchLeafId) continue;

			const branchMessages = reconstructThread(mapping, branchLeafId);
			if (branchMessages.length === 0) continue;

			branches.push({
				divergenceNodeId: parentId,
				branchNodeId: childId,
				weight: childWeight,
				messages: branchMessages,
			});
		}
	}

	return branches;
}

function parseSingleConversation(
	entry: ChatGPTConversation,
): ParsedConversation | null {
	const mapping = entry.mapping ?? {};
	if (
		!mapping ||
		typeof mapping !== "object" ||
		Object.keys(mapping).length === 0
	) {
		return null;
	}

	const messages = reconstructThread(mapping, entry.current_node);

	if (messages.length === 0) {
		return null;
	}

	const branches = detectBranches(mapping, entry.current_node);

	return {
		id: entry.conversation_id || entry.id,
		title: entry.title || "Untitled",
		createdAt: new Date((entry.create_time || 0) * 1000),
		updatedAt: new Date((entry.update_time || 0) * 1000),
		model: entry.default_model_slug ?? undefined,
		messages,
		gizmoId: entry.gizmo_id ?? null,
		branches: branches.length > 0 ? branches : undefined,
	};
}
