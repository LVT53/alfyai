<script lang="ts">
// A3 interactive checklist block. GFM task lists ("- [ ] item") render here as
// ENABLED, tick-able checkboxes (marked's default renders them `disabled`).
// The tick state is local, ephemeral UI state only — display-only
// interactivity, deliberately NOT persisted. `html` is the item body rendered
// as BLOCK-LEVEL markdown (it may contain a nested sub-list, fenced code, or
// several paragraphs), already sanitized by the block renderer upstream.
type ChecklistItem = { checked: boolean; task: boolean; html: string };

let { items = [] }: { items?: ChecklistItem[] } = $props();

// Stable per-instance id base so each checkbox can be associated with its body
// via aria-labelledby without colliding across multiple checklists on a page.
const uid = $props.id();

// Local mirror of each item's checked state. When a streaming answer APPENDS a
// task the item count grows: we must preserve the existing items' tick state
// (an in-progress user tick must survive) and only seed the newly-appended
// items from their parsed markdown state. Merging by index (not re-seeding the
// whole array) is what keeps a tick from being clobbered mid-stream. State is
// per-component-instance, so there is no cross-message bleed. Seeding runs in a
// pre-effect (flushed before first paint) to reflect the parsed checked state
// on initial render without referencing the reactive prop in a plain
// initializer.
let checked = $state<boolean[]>([]);
let syncedLength = $state(0);

$effect.pre(() => {
	const count = items.length;
	if (count === syncedLength) return;

	if (count > syncedLength) {
		// Grew (initial render or an appended task): keep existing ticks, seed
		// only the new tail indices from their own parsed checked state.
		const next = checked.slice(0, syncedLength);
		for (let index = syncedLength; index < count; index += 1) {
			next[index] = items[index].checked;
		}
		checked = next;
	} else {
		// Shrank (message replaced/rewound): drop the trailing entries.
		checked = checked.slice(0, count);
	}
	syncedLength = count;
});
</script>

<ul class="markdown-checklist">
  {#each items as item, index (index)}
    {#if item.task}
      <!-- GFM task-list layout: the checkbox is the leading control and the
           block-level body is its sibling (NOT wrapped in a <label>, which may
           not contain block content and would hijack clicks on links/code
           inside the body). The checkbox is named by the body via
           aria-labelledby. -->
      <li class="markdown-checklist__row markdown-checklist__row--task">
        <input
          type="checkbox"
          class="markdown-checklist__box"
          bind:checked={checked[index]}
          aria-labelledby={`${uid}-item-${index}`}
        />
        <div
          id={`${uid}-item-${index}`}
          class="markdown-checklist__text"
          class:markdown-checklist__text--done={checked[index]}
        >{@html item.html}</div>
      </li>
    {:else}
      <li class="markdown-checklist__row markdown-checklist__row--plain">
        <div class="markdown-checklist__text">{@html item.html}</div>
      </li>
    {/if}
  {/each}
</ul>

<style>
  .markdown-checklist {
    margin: var(--space-sm) 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs, 0.25rem);
  }

  .markdown-checklist__row {
    margin: 0;
    padding: 0;
  }

  .markdown-checklist__row--task {
    display: flex;
    align-items: flex-start;
    gap: 0.5em;
  }

  .markdown-checklist__row--plain {
    padding-left: 1.6em;
    position: relative;
  }

  .markdown-checklist__row--plain::before {
    content: "•";
    position: absolute;
    left: 0.5em;
    color: var(--text-muted);
  }

  .markdown-checklist__box {
    margin: 0;
    margin-top: 0.2em;
    width: 1em;
    height: 1em;
    flex-shrink: 0;
    cursor: pointer;
    accent-color: var(--accent);
  }

  .markdown-checklist__box:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 55%, transparent);
    border-radius: 3px;
  }

  .markdown-checklist__text {
    flex: 1 1 auto;
    min-width: 0;
  }

  .markdown-checklist__text--done {
    color: var(--text-muted);
    text-decoration: line-through;
  }

  /* The body is block-level markdown: collapse the outer paragraph margins so
     the checkbox (aligned flex-start) sits on the first line, not floating
     beside a tall block. */
  .markdown-checklist__text :global(> *:first-child) {
    margin-top: 0;
  }

  .markdown-checklist__text :global(> *:last-child) {
    margin-bottom: 0;
  }
</style>
