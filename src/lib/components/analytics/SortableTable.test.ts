import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import SortableTable from "./SortableTable.svelte";
import type { TableColumn, TableRow } from "./table-sort";

// Analytics overhaul (frontend half) — the View-all/Show-fewer cap added for
// the "Tools & latency" tables. The sort/filter logic itself is covered by
// table-sort.test.ts; these cases pin the component behaviour around the cap.
const columns: TableColumn[] = [
	{ key: "tool", label: "Tool", type: "text" },
	{ key: "calls", label: "Calls", type: "number" },
];

const rows: TableRow[] = [
	{ tool: "alpha", calls: 5 },
	{ tool: "bravo", calls: 40 },
	{ tool: "charlie", calls: 30 },
	{ tool: "delta", calls: 20 },
	{ tool: "echo", calls: 10 },
];

function bodyToolNames(): string[] {
	const table = screen.getByRole("table");
	return [...table.querySelectorAll("tbody tr")].map(
		(row) => row.querySelector("td")?.textContent?.trim() ?? "",
	);
}

describe("SortableTable row cap", () => {
	it("caps the body at maxRows and reveals the rest on View all", async () => {
		render(SortableTable, {
			props: {
				columns,
				rows,
				initialSort: { key: "calls", dir: "desc" as const },
				maxRows: 2,
				showAllLabel: "Showing 2 of 5 · View all 5 →",
				showFewerLabel: "Show fewer",
			},
		});

		expect(bodyToolNames()).toEqual(["bravo", "charlie"]);

		await fireEvent.click(
			screen.getByRole("button", { name: "Showing 2 of 5 · View all 5 →" }),
		);

		expect(bodyToolNames()).toEqual([
			"bravo",
			"charlie",
			"delta",
			"echo",
			"alpha",
		]);

		await fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
		expect(bodyToolNames()).toEqual(["bravo", "charlie"]);
	});

	it("keeps the current sort when expanding and collapsing", async () => {
		render(SortableTable, {
			props: {
				columns,
				rows,
				initialSort: { key: "calls", dir: "desc" as const },
				maxRows: 2,
				showAllLabel: "View all",
				showFewerLabel: "Show fewer",
			},
		});

		// Re-sort ascending by Calls, then expand: the cap must apply to the
		// CURRENT sort, not the initial one.
		await fireEvent.click(screen.getByRole("button", { name: /Calls/ }));
		expect(bodyToolNames()).toEqual(["alpha", "echo"]);

		await fireEvent.click(screen.getByRole("button", { name: "View all" }));
		expect(bodyToolNames()).toEqual([
			"alpha",
			"echo",
			"delta",
			"charlie",
			"bravo",
		]);

		await fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
		expect(bodyToolNames()).toEqual(["alpha", "echo"]);
	});

	it("shows no footer when the row count fits within the cap", () => {
		render(SortableTable, {
			props: {
				columns,
				rows: rows.slice(0, 2),
				maxRows: 5,
				showAllLabel: "View all",
				showFewerLabel: "Show fewer",
			},
		});

		expect(screen.queryByRole("button", { name: "View all" })).toBeNull();
		expect(bodyToolNames()).toHaveLength(2);
	});

	it("leaves the body uncapped when maxRows is omitted", () => {
		render(SortableTable, { props: { columns, rows } });

		expect(bodyToolNames()).toHaveLength(5);
		expect(screen.queryByRole("button", { name: /View all/ })).toBeNull();
	});
});
