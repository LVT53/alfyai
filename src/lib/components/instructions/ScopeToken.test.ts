import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import type { InstructionScope } from "$lib/shared/instructions";
import ScopeToken from "./ScopeToken.svelte";

function token(scope: InstructionScope) {
	return render(ScopeToken, { props: { scope } });
}

describe("ScopeToken", () => {
	it("renders the You label with the user icon and no folder icon for the personal scope", () => {
		const { container } = token({ kind: "personal" });

		expect(screen.getByText("You")).toBeInTheDocument();
		expect(screen.queryByText("Vienna trip")).not.toBeInTheDocument();
		// The user icon carries aria-hidden, so it is not an accessible
		// element — query the DOM, not the accessibility tree.
		expect(container.querySelector(".lucide-user")).not.toBeNull();
		expect(container.querySelector(".lucide-folder")).toBeNull();
	});

	it("names the personal token from the scope, not the bare pronoun", () => {
		token({ kind: "personal" });

		expect(screen.getByRole("img")).toHaveAccessibleName(
			"Instructions for Personal",
		);
	});

	it("renders the project name with the folder icon", () => {
		const { container } = token({
			kind: "project",
			projectId: "p1",
			name: "Vienna trip",
		});

		expect(screen.getByText("Vienna trip")).toBeInTheDocument();
		expect(container.querySelector(".lucide-folder")).not.toBeNull();
		expect(container.querySelector(".lucide-user")).toBeNull();
	});

	it("names the project token from tokenA11y, so the scope word is not lost", () => {
		// The visible name is the project's own name; on its own it says
		// nothing about what it labels.
		token({ kind: "project", projectId: "p1", name: "Vienna trip" });

		expect(screen.getByRole("img")).toHaveAccessibleName("Project Vienna trip");
	});

	it("styles the two sizes from the design tokens", () => {
		const { container: small } = token({ kind: "personal" });
		expect(small.querySelector(".scope-token--sm")).not.toBeNull();

		const { container: medium } = render(ScopeToken, {
			props: { scope: { kind: "personal" }, size: "md" },
		});
		expect(medium.querySelector(".scope-token--md")).not.toBeNull();
	});
});
