// Slice C — personal instructions reach the model.
//
// The unit suites cover each seam: the settings route stores the text, the
// instructions service reads it back, and prompt assembly renders it. What
// none of them covers is the join — a row in the database becoming a section
// of the real, model-facing system prompt, produced by the real preparation
// pipeline against the real (throwaway, migrated) database.
//
// That join is where the feature's two risks live, so this file drives it end
// to end:
//
//   1. The user's text is theirs. A line that looks like section structure
//      (`## Project Instructions`) must stay their text, and a paragraph the
//      deprecated-section stripper would delete anywhere else in the prompt
//      ("preserve tags", the retired English-only translation contract) must
//      survive inside their instructions.
//   2. Instructions are standing guidance: resolved from storage, rendered
//      into the system message where every turn sees them, never into the
//      user packet, whose sections short messages skip.

import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/lib/server/db";
import { conversations, users } from "../../src/lib/server/db/schema";
import { createConversation } from "../../src/lib/server/services/conversations";
import { resolveTurnInstructions } from "../../src/lib/server/services/instructions";
import { prepareOutboundChatContext } from "../../src/lib/server/services/normal-chat-context";
import { validateInstructionInput } from "../../src/lib/shared/instructions";

const TEST_USER_EMAIL = "test-instructions-prompt@example.com";
const TEST_USER_PASSWORD = "testpassword123";

// Everything in here is deliberate. The heading is the shape the feature's own
// copy points users at; the other three paragraphs are the ones
// stripDeprecatedPromptSections deletes outright, each on a token of its own.
const USER_TEXT = [
	"## Project Instructions",
	"Use metric units and 24-hour time.",
	"",
	"Always preserve tags in code.",
	"",
	"You ALWAYS respond in English. Every word you write must be in English.",
	"",
	"Wrap quoted code in <preserve> tags so the translator leaves it alone.",
].join("\n");

const MODEL_CONFIG = {
	baseUrl: "http://local-model/v1",
	apiKey: "local-key",
	modelName: "local-model",
	displayName: "Local Model",
	systemPrompt: "You are a helpful assistant.",
	maxTokens: 4096,
	reasoningEffort: "medium",
	thinkingType: "disabled",
} as const;

const CONTEXT_LIMITS = {
	maxModelContext: 262_144,
	compactionUiThreshold: 209_715,
	targetConstructedContext: 157_286,
};

let testUserId: string;
let testConversationId: string;

async function setStoredInstructions(text: string | null): Promise<void> {
	// The same validation the settings route applies before it writes, so this
	// test stores what a user could actually store.
	const validated = validateInstructionInput(text);
	if (!validated.ok) throw new Error("test fixture is not storable");

	await db
		.update(users)
		.set({ personalInstructions: validated.value })
		.where(eq(users.id, testUserId));
}

async function buildPromptForStoredInstructions() {
	const instructions = await resolveTurnInstructions({
		userId: testUserId,
		conversationId: testConversationId,
	});

	return prepareOutboundChatContext({
		message: "How long is the flight?",
		sessionId: testConversationId,
		modelConfig: MODEL_CONFIG,
		user: { id: testUserId },
		modelId: "model1",
		contextLimits: CONTEXT_LIMITS,
		// A Response Style section has to exist for the ordering assertion to
		// mean anything.
		personalityPrompt: "Be warm and concise.",
		instructions,
		logLabel: "provider request",
	});
}

beforeAll(async () => {
	const existing = await db
		.select()
		.from(users)
		.where(eq(users.email, TEST_USER_EMAIL))
		.limit(1);

	if (existing.length > 0) {
		testUserId = existing[0].id;
	} else {
		testUserId = randomUUID();
		await db.insert(users).values({
			id: testUserId,
			email: TEST_USER_EMAIL,
			passwordHash: await bcrypt.hash(TEST_USER_PASSWORD, 12),
			name: "Test Instructions User",
			role: "user",
		});
	}

	const conversation = await createConversation(
		testUserId,
		"Test Instructions Conversation",
	);
	testConversationId = conversation.id;
});

afterAll(async () => {
	await setStoredInstructions(null);
	await db
		.delete(conversations)
		.where(eq(conversations.id, testConversationId));
});

describe("personal instructions in the assembled prompt", () => {
	it("renders stored instructions verbatim in the system prompt, after Response Style", async () => {
		await setStoredInstructions(USER_TEXT);

		const prepared = await buildPromptForStoredInstructions();
		const prompt = prepared.systemPrompt;

		// The section exists, and the framing says what to do with it.
		expect(prompt).toContain("## Your Instructions");
		expect(prompt).toContain(
			"the user's current message overrides all of them",
		);

		// It follows the Response Style section it yields to.
		const responseStyleIndex = prompt.indexOf("## Response Style");
		const instructionsIndex = prompt.indexOf("## Your Instructions");
		expect(responseStyleIndex).toBeGreaterThan(-1);
		expect(instructionsIndex).toBeGreaterThan(responseStyleIndex);

		// The user's heading is text inside the section, not a section of its
		// own: it is present with the four-space indent that marks their lines,
		// and it comes after the section heading.
		expect(prompt).toContain("\n    ## Project Instructions\n");
		expect(prompt.indexOf("## Project Instructions")).toBeGreaterThan(
			instructionsIndex,
		);
		expect(prompt).toContain("Use metric units and 24-hour time.");

		// Every paragraph the deprecated-section stripper would delete is still
		// in the model-facing prompt, because the section is appended after
		// stripping runs.
		expect(prompt).toContain("Always preserve tags in code.");
		expect(prompt).toContain(
			"You ALWAYS respond in English. Every word you write must be in English.",
		);
		expect(prompt).toContain(
			"Wrap quoted code in <preserve> tags so the translator leaves it alone.",
		);

		// Standing guidance belongs in the system message; the user packet's
		// folder sections are skipped on short messages, so instructions put
		// there would silently not apply.
		expect(prepared.inputValue).not.toContain("Use metric units");
	});

	it("renders no section at all when the user has stored nothing", async () => {
		await setStoredInstructions(null);

		const prepared = await buildPromptForStoredInstructions();

		expect(prepared.systemPrompt).not.toContain("## Your Instructions");
	});
});
