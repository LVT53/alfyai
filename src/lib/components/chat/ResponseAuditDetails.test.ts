import { cleanup, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "$lib/server/services/messages-types";
import { projects } from "$lib/stores/projects";
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

describe("ResponseAuditDetails project files row", () => {
	function projectFilesRow() {
		// Pinned as a literal, not read back out of the dictionary: the label the
		// owner approved is "Project files", and a test that recomputes it from
		// the same dictionary it is checking would agree with any rewording.
		return screen.queryByText("Project files")?.closest(".audit-row") ?? null;
	}

	function renderWithFiles(count: number | undefined) {
		render(ResponseAuditDetails, {
			message: buildMessage({ projectFilesRead: count }),
			onOpenSources: () => undefined,
		});
	}

	it("shows no Project files row in the Info popover when the count is zero", () => {
		renderWithFiles(undefined);

		// A row that says "0 read" would be a row about nothing, and the popover
		// is a glance. Nothing to say means no row.
		expect(projectFilesRow()).toBeNull();

		cleanup();
		renderWithFiles(0);
		expect(projectFilesRow()).toBeNull();
	});

	it("shows the count and the Sources hint when files were read", () => {
		renderWithFiles(2);

		const row = projectFilesRow();
		expect(row).not.toBeNull();
		expect(row).toHaveTextContent("2 read · see Sources ↓");

		// One file is not "1 read(s)": the singular is its own string, because
		// the row is read at a glance and a bracketed plural is not one.
		cleanup();
		renderWithFiles(1);
		expect(projectFilesRow()).toHaveTextContent("1 read · see Sources ↓");

		cleanup();
		renderWithFiles(5);
		expect(projectFilesRow()).toHaveTextContent("5 read · see Sources ↓");
	});

	it("never puts a file name in the Info row", () => {
		render(ResponseAuditDetails, {
			message: buildMessage({
				projectFilesRead: 1,
				evidenceSummary: {
					structuredWebSearch: false,
					groups: [
						{
							sourceType: "document",
							label: "Documents",
							reranked: false,
							items: [
								{
									id: "evidence-1",
									title: "Wien itinerary.md",
									sourceType: "document",
									status: "selected",
									artifactId: "artifact-project",
									metadata: {
										projectId: "project-1",
										projectName: "Vienna trip",
									},
								},
							],
						},
					],
				},
			}),
			onOpenSources: () => undefined,
		});

		// The panel is a glance and can be on a shared screen: the file names
		// live in Sources, where the user can open them. The row says how many,
		// and the hint says where to look — never the names themselves.
		expect(screen.queryByText(/Wien itinerary/)).toBeNull();
		expect(screen.queryByText(/\.md/)).toBeNull();
		expect(projectFilesRow()).toHaveTextContent("1 read · see Sources ↓");
	});
});
