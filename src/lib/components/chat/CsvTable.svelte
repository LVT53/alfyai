<script lang="ts">
// A3 Stage 2 diagram kind: a ```csv fence rendered as a first-class table.
// Reuses the .markdown-table-wrap / .markdown-table markup so it inherits the
// same scroll/overflow behaviour as GFM tables (MarkdownRenderer's
// enhanceRenderedTables enhances any `.markdown-table-wrap table` in the
// container, including this one). Values are rendered as plain text (Svelte
// auto-escapes), so there is no HTML-injection surface — no sanitizer change is
// needed for CSV.

let { code = "" }: { code?: string } = $props();

// Minimal RFC-4180-ish CSV parser: supports quoted fields, embedded commas /
// newlines inside quotes, and "" escaped quotes. First non-empty row is the
// header. Deliberately small — this is chat-answer CSV, not a spreadsheet import.
function parseCsv(input: string): string[][] {
	const rows: string[][] = [];
	let field = "";
	let row: string[] = [];
	let inQuotes = false;
	let started = false;

	const pushField = () => {
		row.push(field);
		field = "";
	};
	const pushRow = () => {
		pushField();
		rows.push(row);
		row = [];
		started = false;
	};

	for (let i = 0; i < input.length; i += 1) {
		const char = input[i];
		if (inQuotes) {
			if (char === '"') {
				if (input[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"') {
			inQuotes = true;
			started = true;
		} else if (char === ",") {
			pushField();
			started = true;
		} else if (char === "\n") {
			pushRow();
		} else if (char === "\r") {
			// swallow — a following \n triggers the row break
		} else {
			field += char;
			started = true;
		}
	}
	// Flush the trailing field/row unless the input ended on a clean row break.
	if (started || field.length > 0 || row.length > 0) {
		pushRow();
	}

	return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

const rows = $derived(parseCsv(code));
const header = $derived(rows[0] ?? []);
const body = $derived(rows.slice(1));
const columnCount = $derived(
	rows.reduce((max, cells) => Math.max(max, cells.length), 0),
);

function padded(cells: string[]): string[] {
	if (cells.length >= columnCount) return cells;
	return [...cells, ...Array(columnCount - cells.length).fill("")];
}
</script>

{#if rows.length === 0}
  <!-- Nothing parseable — degrade to the raw source rather than an empty table. -->
  <pre class="markdown-csv-empty"><code>{code}</code></pre>
{:else}
  <div class="markdown-table-wrap">
    <table class="markdown-table">
      <thead>
        <tr>
          {#each padded(header) as cell}
            <th>{cell}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each body as bodyRow}
          <tr>
            {#each padded(bodyRow) as cell}
              <td>{cell}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .markdown-csv-empty {
    margin: var(--space-sm) 0;
    padding: var(--space-sm);
    border-radius: var(--radius-md, 0.5rem);
    border: 1px solid var(--border-default);
    background: var(--surface-code);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
