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

import { eq } from "drizzle-orm";
import { users } from "$lib/server/db/schema";
import { getInstructionText, resolveTurnInstructions } from "./instructions";

const PARAMS = { userId: "user-1", conversationId: "conv-1" };

beforeEach(() => {
	selectedRows.value = [];
	selectWhere.mockClear();
	selectFrom.mockClear();
	vi.mocked(eq).mockClear();
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

	it("returns project null while the project half is not landed", async () => {
		// Slice D fills this in from the conversation's project. Until then the
		// field is part of the signature so that no caller has to change when
		// it starts returning a value.
		selectedRows.value = [{ personalInstructions: "Use metric units." }];

		const resolved = await resolveTurnInstructions(PARAMS);

		expect(resolved.project).toBeNull();
		// One read of the user row, and nothing else: there is no project
		// instructions column to read yet.
		expect(selectFrom).toHaveBeenCalledTimes(1);
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

	it("returns null for a project scope until projects carry instructions", async () => {
		// Slice C ships no project instructions. Returning null (rather than
		// reading something unrelated and calling it project instructions) is
		// what keeps the Settings and archive callers honest: "nothing is set"
		// is the true answer today.
		selectedRows.value = [{ personalInstructions: "Be brief." }];

		expect(
			await getInstructionText("user-1", {
				kind: "project",
				projectId: "project-1",
			}),
		).toBeNull();
		expect(selectFrom).not.toHaveBeenCalled();
	});
});
