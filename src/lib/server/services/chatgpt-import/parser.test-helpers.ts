import JSZip from "jszip";
import type {
	ChatGPTCodeContent,
	ChatGPTConversation,
	ChatGPTExecutionOutputContent,
	ChatGPTImagePart,
	ChatGPTMappingNode,
	ChatGPTMessage,
	ChatGPTMultimodalTextContent,
	ChatGPTTextContent,
	ChatGPTTextPart,
} from "./parser";
import { reconstructThread } from "./parser";

export function makeTextContent(
	parts: ChatGPTTextContent["parts"] = ["Hello"],
): ChatGPTTextContent {
	return {
		content_type: "text",
		parts,
	};
}

export function makeCodeContent(
	language: string,
	text: string,
): ChatGPTCodeContent {
	return {
		content_type: "code",
		language,
		text,
	};
}

export function makeExecutionOutputContent(
	parts: ChatGPTExecutionOutputContent["parts"],
): ChatGPTExecutionOutputContent {
	return {
		content_type: "execution_output",
		parts,
	};
}

export function makeTextPart(text: string): ChatGPTTextPart {
	return {
		content_type: "text",
		text,
	};
}

export function makeImagePart(
	overrides: Partial<ChatGPTImagePart> = {},
): ChatGPTImagePart {
	return {
		content_type: "image_asset_pointer",
		asset_pointer: "file-abc123",
		size_bytes: 1024,
		width: 800,
		height: 600,
		fovea: null,
		metadata: null,
		...overrides,
	};
}

export function makeMultimodalTextContent(
	parts: ChatGPTMultimodalTextContent["parts"],
): ChatGPTMultimodalTextContent {
	return {
		content_type: "multimodal_text",
		parts,
	};
}

export function makeMessage(
	overrides: Partial<ChatGPTMessage> = {},
): ChatGPTMessage {
	return {
		id: "msg-1",
		author: { role: "user", name: null, metadata: {} },
		create_time: 1000000,
		update_time: null,
		content: makeTextContent(),
		status: "finished_successfully",
		end_turn: true,
		weight: 1,
		metadata: {},
		recipient: "all",
		channel: null,
		...overrides,
	};
}

export function makeTextMessage(
	text: string,
	overrides: Partial<ChatGPTMessage> = {},
): ChatGPTMessage {
	return makeMessage({ content: makeTextContent([text]), ...overrides });
}

export function makeCodeMessage(
	language: string,
	text: string,
	overrides: Partial<ChatGPTMessage> = {},
): ChatGPTMessage {
	return makeMessage({
		content: makeCodeContent(language, text),
		...overrides,
	});
}

export function makeNode(
	id: string,
	message: ChatGPTMessage | null,
	parent: string | null,
	children: string[],
): ChatGPTMappingNode {
	return { id, message, parent, children };
}

export function reconstructFromSingleNode(
	message: ChatGPTMessage,
	currentNode: string | null = "n1",
) {
	return reconstructThread(
		{
			n1: makeNode("n1", message, null, []),
		},
		currentNode,
	);
}

export function makeConversation(
	overrides: Partial<ChatGPTConversation> = {},
): ChatGPTConversation {
	const message = makeTextMessage("Hello");
	const node = makeNode("leaf", message, null, []);

	return {
		id: "conv-1",
		title: "Test Conversation",
		create_time: 1700000000,
		update_time: 1700001000,
		mapping: { leaf: node },
		current_node: "leaf",
		conversation_id: "conv-1",
		moderation_results: [],
		plugin_ids: null,
		conversation_template_id: null,
		gizmo_id: null,
		gizmo_type: null,
		is_archived: false,
		is_starred: null,
		safe_urls: [],
		default_model_slug: null,
		conversation_origin: null,
		voice: null,
		async_status: null,
		disabled_tool_ids: [],
		...overrides,
	};
}

export async function makeZipWithConversations(
	conversations: ChatGPTConversation[],
): Promise<Buffer> {
	return makeZipBuffer((zip) => {
		zip.file("conversations.json", JSON.stringify(conversations));
	});
}

export async function makeZipBuffer(
	build: (zip: JSZip) => void,
): Promise<Buffer> {
	const zip = new JSZip();
	build(zip);
	return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}
