import { cleanup, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "$lib/server/services/messages-types";
import { uiLanguage } from "$lib/stores/settings";
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
		// The project token renders what the record gives it: a projectId, no
		// name (Slice D supplies one). It must not invent a label.
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
