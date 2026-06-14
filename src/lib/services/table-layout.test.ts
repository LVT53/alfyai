// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
	deriveBalancedColumnWidths,
	getTableColumnCount,
	hasExtremeUnbreakableContent,
	resolveTableOverflowMode,
} from "./table-layout";

function createTable(markup: string): HTMLTableElement {
	document.body.innerHTML = markup;
	return document.querySelector("table") as HTMLTableElement;
}

describe("table-layout", () => {
	it("counts columns from the first row", () => {
		const table = createTable(`
			<table>
				<thead>
					<tr><th>Title</th><th>Status</th><th>Notes</th></tr>
				</thead>
			</table>
		`);

		expect(getTableColumnCount(table)).toBe(3);
	});

	it("derives balanced widths that give more room to longer columns", () => {
		const table = createTable(`
			<table>
				<thead>
					<tr><th>Long descriptive title column</th><th>Status</th><th>Notes</th></tr>
				</thead>
				<tbody>
					<tr><td>This column contains much more text than the others</td><td>Done</td><td>Short</td></tr>
				</tbody>
			</table>
		`);

		const widths = deriveBalancedColumnWidths(table, 3);
		expect(widths).not.toBeNull();
		const numeric = (widths ?? []).map((width) => Number.parseFloat(width));
		expect(numeric).toHaveLength(3);
		expect(numeric[0]).toBeGreaterThan(numeric[1]);
		expect(numeric[0]).toBeGreaterThan(numeric[2]);
		expect(numeric.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 1);
	});

	it("detects extreme unbreakable content", () => {
		const table = createTable(`
			<table>
				<tbody>
					<tr><td>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</td></tr>
				</tbody>
			</table>
		`);

		expect(hasExtremeUnbreakableContent(table)).toBe(true);
	});

	it("falls back to scroll when measured width still overflows", () => {
		expect(
			resolveTableOverflowMode({
				columnCount: 3,
				wrapperWidth: 300,
				tableWidth: 360,
			}),
		).toBe("scroll");
	});

	it("keeps fit mode for ordinary 3-column tables inside the container width", () => {
		expect(
			resolveTableOverflowMode({
				columnCount: 3,
				wrapperWidth: 360,
				tableWidth: 360,
			}),
		).toBe("fit");
	});
});
