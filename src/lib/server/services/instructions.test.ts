import { beforeEach, describe, expect, it, vi } from "vitest";

const selectedRows = vi.hoisted(() => ({
	value: [] as Array<Record<string, unknown>>,
}));
const selectWhere = vi.hoisted(() => vi.fn(async () => selectedRows.value));
const selectFrom = vi.hoisted(() => vi.fn(() => ({ where: selectWhere })));

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn(() => ({ from: selectFrom })),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	users: {
		id: "users.id",
		personalInstructions: "users.personal_instructions",
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

// The project half is read through the project service, so this file tests the
// *resolution* (which project, in what order, with which owner) and leaves the
// ownership check itself to projects.test.ts, where it runs against a real
// database. Both mocks resolve "nothing" by default, which is what keeps every
// personal-only test below true.
const projectMocks = vi.hoisted(() => ({
	getConversationProjectId: vi.fn(async () => null as string | null),
	getProjectInstructions: vi.fn(
		async (): Promise<{
			id: string;
			name: string;
			text: string | null;
		} | null> => null,
	),
}));

vi.mock("./projects", () => ({
	getConversationProjectId: projectMocks.getConversationProjectId,
	getProjectInstructions: projectMocks.getProjectInstructions,
}));

import { eq } from "drizzle-orm";
import { users } from "$lib/server/db/schema";
import { getInstructionText, resolveTurnInstructions } from "./instructions";

const PARAMS = { userId: "user-1", conversationId: "conv-1" };

beforeEach(() => {
	selectedRows.value = [];
	selectWhere.mockClear();
	selectFrom.mockClear();
	vi.mocked(eq).mockClear();
	projectMocks.getConversationProjectId.mockReset();
	projectMocks.getConversationProjectId.mockResolvedValue(null);
	projectMocks.getProjectInstructions.mockReset();
	projectMocks.getProjectInstructions.mockResolvedValue(null);
});

describe("resolveTurnInstructions", () => {
	it("returns null personal instructions when the column is empty", async () => {
		selectedRows.value = [{ personalInstructions: null }];

		expect(await resolveTurnInstructions(PARAMS)).toEqual({
			personal: null,
			project: null,
		});
	});

	it("treats whitespace-only stored text as unset, not as instructions", async () => {
		// The column can only hold whitespace if it was written outside the
		// settings API; a section renderer that printed four spaces of it into
		// the system prompt would spend tokens on nothing.
		selectedRows.value = [{ personalInstructions: "   \n  " }];

		expect(await resolveTurnInstructions(PARAMS)).toEqual({
			personal: null,
			project: null,
		});
	});

	it("returns the trimmed personal text", async () => {
		selectedRows.value = [{ personalInstructions: "  Use metric units.  " }];

		expect(await resolveTurnInstructions(PARAMS)).toEqual({
			personal: "Use metric units.",
			project: null,
		});
	});

	it("reads the text through the authenticated user id and no other row", async () => {
		selectedRows.value = [{ personalInstructions: "Use metric units." }];

		await resolveTurnInstructions(PARAMS);

		expect(vi.mocked(eq)).toHaveBeenCalledWith(users.id, "user-1");
		expect(selectFrom).toHaveBeenCalledWith(users);
	});

	it("returns nothing at all when the user row cannot be read", async () => {
		selectedRows.value = [];

		expect(await resolveTurnInstructions(PARAMS)).toEqual({
			personal: null,
			project: null,
		});
	});

	it("returns project null while the conversation has no project", async () => {
		selectedRows.value = [{ personalInstructions: "Use metric units." }];

		expect(await resolveTurnInstructions(PARAMS)).toEqual({
			personal: "Use metric units.",
			project: null,
		});
		// No project id means no second read: the project's row is only ever
		// opened for a conversation that is actually in one.
		expect(projectMocks.getProjectInstructions).not.toHaveBeenCalled();
	});

	it("resolves the conversation's project instructions for the turn", async () => {
		selectedRows.value = [{ personalInstructions: "Use metric units." }];
		projectMocks.getConversationProjectId.mockResolvedValue("project-vienna");
		projectMocks.getProjectInstructions.mockResolvedValue({
			id: "project-vienna",
			name: "Vienna trip",
			text: "Only suggest trains, never flights.",
		});

		expect(await resolveTurnInstructions(PARAMS)).toEqual({
			personal: "Use metric units.",
			project: {
				id: "project-vienna",
				name: "Vienna trip",
				text: "Only suggest trains, never flights.",
			},
		});
		expect(projectMocks.getConversationProjectId).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
		);
		expect(projectMocks.getProjectInstructions).toHaveBeenCalledWith(
			"user-1",
			"project-vienna",
		);
	});

	it("returns project null when the project has no instructions", async () => {
		// A project is a folder first: most of them carry no instructions, and
		// an empty block would be a heading and a paragraph of framing about
		// nothing.
		selectedRows.value = [{ personalInstructions: null }];
		projectMocks.getConversationProjectId.mockResolvedValue("project-vienna");
		projectMocks.getProjectInstructions.mockResolvedValue({
			id: "project-vienna",
			name: "Vienna trip",
			text: null,
		});

		expect(await resolveTurnInstructions(PARAMS)).toEqual({
			personal: null,
			project: null,
		});
	});

	it("does not resolve another user's project", async () => {
		// The ownership check is the lookup's own: a conversation in somebody
		// else's project resolves to no project at all, not to their text. The
		// real check runs against a database in projects.test.ts; what this pins
		// is that no instruction reaches the prompt when the lookup says no.
		selectedRows.value = [{ personalInstructions: null }];
		projectMocks.getConversationProjectId.mockResolvedValue(null);

		expect(await resolveTurnInstructions(PARAMS)).toEqual({
			personal: null,
			project: null,
		});
		expect(projectMocks.getProjectInstructions).not.toHaveBeenCalled();
	});

	it("re-resolves the conversation's project on every turn", async () => {
		// The move in and the move out, at the resolution layer: nothing is
		// cached between turns, so the block that reaches the model is always
		// the project the conversation is in *now*.
		selectedRows.value = [{ personalInstructions: null }];
		projectMocks.getConversationProjectId.mockResolvedValue("project-vienna");
		projectMocks.getProjectInstructions.mockResolvedValue({
			id: "project-vienna",
			name: "Vienna trip",
			text: "Only suggest trains, never flights.",
		});

		const insideProject = await resolveTurnInstructions(PARAMS);
		expect(insideProject.project?.id).toBe("project-vienna");

		// Moved back out of the project before the next turn.
		projectMocks.getConversationProjectId.mockResolvedValue(null);
		const movedOut = await resolveTurnInstructions(PARAMS);
		expect(movedOut.project).toBeNull();

		// And moved into a different one.
		projectMocks.getConversationProjectId.mockResolvedValue("project-prague");
		projectMocks.getProjectInstructions.mockResolvedValue({
			id: "project-prague",
			name: "Prague trip",
			text: "Ask about the train from Vienna.",
		});

		const movedIn = await resolveTurnInstructions(PARAMS);
		expect(movedIn.project).toEqual({
			id: "project-prague",
			name: "Prague trip",
			text: "Ask about the train from Vienna.",
		});
	});
});

describe("getInstructionText", () => {
	it("reads the personal scope for the given user", async () => {
		selectedRows.value = [{ personalInstructions: "  Be brief. " }];

		expect(await getInstructionText("user-1", { kind: "personal" })).toBe(
			"Be brief.",
		);
		expect(vi.mocked(eq)).toHaveBeenCalledWith(users.id, "user-1");
	});

	it("returns null when the personal scope is unset", async () => {
		selectedRows.value = [{ personalInstructions: null }];

		expect(await getInstructionText("user-1", { kind: "personal" })).toBeNull();
	});

	it("reads the project scope through the project service, for the given owner", async () => {
		projectMocks.getProjectInstructions.mockResolvedValue({
			id: "project-1",
			name: "House tasks",
			text: "Always ask before booking anything.",
		});

		expect(
			await getInstructionText("user-1", {
				kind: "project",
				projectId: "project-1",
			}),
		).toBe("Always ask before booking anything.");
		expect(projectMocks.getProjectInstructions).toHaveBeenCalledWith(
			"user-1",
			"project-1",
		);
		// The personal column is not read for a project scope: two rows, two
		// questions, and a caller that asked the second must not be answered
		// with the first.
		expect(selectFrom).not.toHaveBeenCalled();
	});

	it("returns null for a project scope that is unset, or not the user's", async () => {
		projectMocks.getProjectInstructions.mockResolvedValue({
			id: "project-1",
			name: "House tasks",
			text: null,
		});
		expect(
			await getInstructionText("user-1", {
				kind: "project",
				projectId: "project-1",
			}),
		).toBeNull();

		// Another user's project reads as missing, not as theirs.
		projectMocks.getProjectInstructions.mockResolvedValue(null);
		expect(
			await getInstructionText("user-1", {
				kind: "project",
				projectId: "project-somebody-else",
			}),
		).toBeNull();
	});
});
