<script lang="ts">
// A3 checklist block. GFM task lists ("- [ ] item") render here as READ-ONLY
// checkboxes that faithfully mirror the model's `[ ]`/`[x]` state. They are
// deliberately NOT interactive: the content belongs to the assistant's reply,
// and an editable tick that silently resets on refresh is a false affordance
// (owner decision). `html` is the item body rendered as BLOCK-LEVEL markdown
// (it may contain a nested sub-list, fenced code, or several paragraphs),
// already sanitized by the block renderer upstream.
type ChecklistItem = { checked: boolean; task: boolean; html: string };

let { items = [] }: { items?: ChecklistItem[] } = $props();

// Stable per-instance id base so each checkbox can be associated with its body
// via aria-labelledby without colliding across multiple checklists on a page.
const uid = $props.id();
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
          checked={item.checked}
          disabled
          aria-labelledby={`${uid}-item-${index}`}
        />
        <div
          id={`${uid}-item-${index}`}
          class="markdown-checklist__text"
          class:markdown-checklist__text--done={item.checked}
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

  /* Read-only: the box reflects the model's state and is not clickable. Keep it
     at full opacity and a default cursor so it reads as a rendered mark, not a
     greyed-out disabled control. */
  .markdown-checklist__box {
    margin: 0;
    margin-top: 0.2em;
    width: 1em;
    height: 1em;
    flex-shrink: 0;
    cursor: default;
    opacity: 1;
    accent-color: var(--accent);
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
