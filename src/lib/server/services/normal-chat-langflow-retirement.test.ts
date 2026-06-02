import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

const retiredTransportFiles = [
	"src/lib/server/services/langflow.ts",
	"src/lib/server/services/langflow-model-run.ts",
];

const retiredTestResidueFiles = [
	"tests/mocks/langflow-server.ts",
	"tests/mocks/start-mocks.ts",
];

const activeNormalChatFiles = [
	"src/routes/api/chat/send/+server.ts",
	"src/routes/api/chat/stream/+server.ts",
	"src/lib/server/services/chat-turn/plain-normal-chat-model-run.ts",
	"src/lib/server/services/chat-turn/streaming-normal-chat-model-run.ts",
	"src/lib/server/services/chat-turn/stream-orchestrator.ts",
	"src/lib/server/services/chat-turn/stream-fallback.ts",
	"src/routes/api/conversations/[id]/context-compression/+server.ts",
	"src/lib/server/services/context-compression.ts",
	"src/lib/server/services/normal-chat-context.ts",
	"src/lib/server/services/normal-chat-control-model.ts",
	"src/lib/server/services/normal-chat-failover.ts",
	"src/lib/server/services/normal-chat-model/index.ts",
	"src/lib/server/services/normal-chat-tools/index.ts",
];

describe("Normal Chat Langflow retirement", () => {
	it("keeps active Normal Chat paths off the retired Langflow transport", () => {
		for (const file of retiredTransportFiles) {
			expect(
				existsSync(join(repoRoot, file)),
				`${file} should be deleted`,
			).toBe(false);
		}

		for (const file of activeNormalChatFiles) {
			const source = readFileSync(join(repoRoot, file), "utf8");

			expect(
				source,
				`${file} should not import the old Langflow service`,
			).not.toMatch(/services\/langflow|\.\/langflow|langflow-model-run/);
			expect(
				source,
				`${file} should not call old Langflow transport helpers`,
			).not.toMatch(
				/sendMessage(Stream)?\(|isLangflowTimeoutError|resolveTimeoutFailoverTargetModelId/,
			);
		}
	});

	it("removes Langflow-shaped shared test and type residue", () => {
		for (const file of retiredTestResidueFiles) {
			expect(
				existsSync(join(repoRoot, file)),
				`${file} should be deleted`,
			).toBe(false);
		}

		const sharedTypes = readFileSync(
			join(repoRoot, "src/lib/types.ts"),
			"utf8",
		);
		expect(sharedTypes).not.toMatch(
			/LangflowMessage|LangflowRunRequest|LangflowRunResponse|WebhookSentencePayload/,
		);
		expect(sharedTypes).not.toContain("Langflow session_id");

		const chatE2e = readFileSync(
			join(repoRoot, "tests/e2e/chat.spec.ts"),
			"utf8",
		);
		expect(chatE2e).not.toMatch(/mock Langflow|MOCK_LANGFLOW/i);
	});
});
