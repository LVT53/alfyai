import { getConfig } from "$lib/server/config-store";
import {
	type SemanticEmbeddingInput,
	upsertSemanticEmbedding,
} from "$lib/server/services/semantic-embeddings";
import {
	canUseTeiEmbedder,
	embedText,
} from "$lib/server/services/tei-embedder";

function buildImportSourceText(
	title: string,
	messages: { role: string; content: string }[],
): string {
	const lines = [`Title: ${title}`];
	for (const msg of messages) {
		lines.push(`${msg.role}: ${msg.content}`);
	}
	return lines.join("\n");
}

/**
 * Generate and persist a semantic embedding for an imported conversation.
 *
 * Callers SHOULD NOT await this promise on the critical import path — it is
 * designed to run as a fire-and-forget background operation.  Failures are
 * logged and swallowed so they never block the import.
 */
export async function generateImportEmbeddings(
	conversationId: string,
	userId: string,
	title: string,
	messages: { role: string; content: string }[],
): Promise<void> {
	if (!canUseTeiEmbedder()) {
		return;
	}

	const config = getConfig();
	const modelName = config.teiEmbedderModel || "tei-embedder";

	const sourceText = buildImportSourceText(title, messages);

	let embedding: number[] | null;
	try {
		embedding = await embedText(sourceText);
	} catch (err) {
		console.error(
			"[CHATGPT_IMPORT] Embedding generation failed:",
			err instanceof Error ? err.message : String(err),
		);
		return;
	}

	if (!embedding || embedding.length === 0) {
		return;
	}

	const input: SemanticEmbeddingInput = {
		userId,
		subjectType: "imported_conversation",
		subjectId: conversationId,
		modelName,
		sourceText,
		embedding,
	};

	try {
		await upsertSemanticEmbedding(input);
	} catch (err) {
		console.error(
			"[CHATGPT_IMPORT] Embedding persistence failed:",
			err instanceof Error ? err.message : String(err),
		);
	}
}
