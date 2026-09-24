import { cleanup, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "$lib/server/services/messages-types";
import { uiLanguage } from "$lib/stores/settings";
import { projects } from "$lib/stores/projects";
import ResponseAuditDetails from "./ResponseAuditDetails.svelte";

function buildMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: "assistant-1",
		renderKey: "assistant-1",
		role: "assistant",
		content: "A Railjet a leggyorsabb.",
		timestamp: Date.now(),
		...overrides,
	};
}

function instructionRow() {
	// Pinned as a literal, not read back out of the dictionary: the label the
	// owner approved is "Instructions", and a test that recomputes it from the
	// same dictionary it is checking would agree with any rewording.
	return screen.getByText("Instructions").closest(".audit-row");
}

beforeEach(() => {
	uiLanguage.set("en");
});

afterEach(() => {
	cleanup();
	uiLanguage.set("en");
	projects.set([]);
});

describe("ResponseAuditDetails instruction provenance row", () => {
	it("shows no Instructions row in the Info popover when nothing applied", () => {
		render(ResponseAuditDetails, { message: buildMessage() });

		// Neither the row nor its tokens: an "Instructions" row with an empty
		// value would tell the reader nothing and claim something happened.
		expect(screen.queryByText("Instructions")).toBeNull();
		expect(screen.queryAllByTestId("scope-token")).toHaveLength(0);
	});

	it("shows the You token and the project token when both applied", () => {
		render(ResponseAuditDetails, {
			message: buildMessage({
				instructionsApplied: { personal: true, projectId: "project-1" },
			}),
		});

		const row = instructionRow();
		expect(row).not.toBeNull();
		const tokens = within(row as HTMLElement).getAllByTestId("scope-token");
		expect(tokens).toHaveLength(2);
		expect(tokens[0]).toHaveAttribute("data-kind", "personal");
		expect(tokens[0]).toHaveTextContent("You");
		// The project token renders what the record and the shell give it: a
		// projectId, and — when the shell's project list knows that id — the
		// project's name. Here the list is empty, so it has nothing to draw
		// and must not invent a label.
		expect(tokens[1]).toHaveAttribute("data-kind", "project");
		expect(tokens[1]).toHaveTextContent("");
	});

	it("shows only the You token when only personal instructions applied", () => {
		render(ResponseAuditDetails, {
			message: buildMessage({ instructionsApplied: { personal: true } }),
		});

		const row = instructionRow();
		expect(row).not.toBeNull();
		const tokens = within(row as HTMLElement).getAllByTestId("scope-token");
		expect(tokens).toHaveLength(1);
		expect(tokens[0]).toHaveAttribute("data-kind", "personal");
	});

	it("names the project the turn applied when the shell knows it", () => {
		projects.set([
			{
				id: "project-1",
				name: "Vienna trip",
				color: null,
				sortOrder: 0,
				createdAt: 0,
				updatedAt: 0,
				hasInstructions: true,
			},
		]);

		render(ResponseAuditDetails, {
			message: buildMessage({
				instructionsApplied: { personal: true, projectId: "project-1" },
			}),
		});

		// The row is read on a screen that may be shared, so the *scope* is
		// what it shows and never the text the user wrote. The project's name
		// is not that text: it is already on the sidebar and in the chat's own
		// breadcrumb, and a token with no label at all tells the reader
		// nothing — which is what this row did while it waited for the project
		// surface to exist.
		const row = instructionRow();
		expect(row).not.toBeNull();
		const tokens = within(row as HTMLElement).getAllByTestId("scope-token");
		expect(tokens).toHaveLength(2);
		expect(tokens[1]).toHaveTextContent("Vienna trip");
		expect(tokens[1]).toHaveAttribute("aria-label", "Project Vienna trip");
	});

	it("shows only the project token when only the project block applied", () => {
		render(ResponseAuditDetails, {
			message: buildMessage({
				instructionsApplied: { personal: false, projectId: "project-1" },
			}),
		});

		const row = instructionRow();
		expect(row).not.toBeNull();
		const tokens = within(row as HTMLElement).getAllByTestId("scope-token");
		expect(tokens).toHaveLength(1);
		expect(tokens[0]).toHaveAttribute("data-kind", "project");
	});
});
