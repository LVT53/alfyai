import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import CsvTable from "./CsvTable.svelte";

describe("CsvTable", () => {
	it("renders CSV as a first-class table with the header row in <thead>", () => {
		const { container } = render(CsvTable, {
			props: { code: "name,value\nalpha,1\nbeta,2" },
		});

		// Reuses the shared table markup so it inherits scroll/overflow behaviour.
		expect(container.querySelector(".markdown-table-wrap")).toBeTruthy();
		const table = container.querySelector("table.markdown-table");
		expect(table).toBeTruthy();

		const headers = Array.from(container.querySelectorAll("thead th")).map(
			(th) => th.textContent,
		);
		expect(headers).toEqual(["name", "value"]);

		const bodyRows = container.querySelectorAll("tbody tr");
		expect(bodyRows).toHaveLength(2);
		expect(bodyRows[0].textContent).toContain("alpha");
		expect(bodyRows[0].textContent).toContain("1");
		expect(bodyRows[1].textContent).toContain("beta");
	});

	it("handles quoted fields with embedded commas and escaped quotes", () => {
		const { container } = render(CsvTable, {
			props: { code: 'a,b\n"one, two","he said ""hi"""' },
		});

		const cells = Array.from(container.querySelectorAll("tbody td")).map(
			(td) => td.textContent,
		);
		expect(cells).toEqual(["one, two", 'he said "hi"']);
	});

	it("does not inject raw HTML from cell values (auto-escaped text)", () => {
		const { container } = render(CsvTable, {
			props: { code: "col\n<img src=x onerror=alert(1)>" },
		});

		// The value must be rendered as text, never as a live <img> element.
		expect(container.querySelector("tbody img")).toBeNull();
		expect(container.querySelector("tbody td")?.textContent).toContain(
			"<img src=x onerror=alert(1)>",
		);
	});

	it("degrades to the raw source when there is nothing parseable", () => {
		const { container } = render(CsvTable, { props: { code: "   \n  " } });
		expect(container.querySelector("table")).toBeNull();
		expect(container.querySelector(".markdown-csv-empty")).toBeTruthy();
	});
});
