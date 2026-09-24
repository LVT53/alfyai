<script lang="ts">
import { Folder, User } from "@lucide/svelte";
import type { InstructionScope } from "$lib/shared/instructions";
import { t } from "$lib/i18n";

// One scope, rendered as a token everywhere it appears: the dialog's title,
// the scope switch, the Settings row and (Slice D) the Info popover and the
// project page. Never in running text — a project name inside a sentence
// cannot be told apart from the sentence's own words, and the whole point of
// the token is that the scope is unmistakable at a glance.
let {
	scope,
	size = "sm",
}: {
	scope: InstructionScope;
	// "sm" is the inline token (dialog title, audit row); "md" is the row
	// token in the scope switch and the Settings row.
	size?: "sm" | "md";
} = $props();

let isProject = $derived(scope.kind === "project");
let label = $derived(
	isProject ? (scope.name ?? "") : $t("instructions.scopeYou"),
);
// The visible project name is the project's own name, which says nothing
// about *what* it labels. The accessible name has to carry the scope word, or
// a screen reader hears a bare project name with no qualifier — set on an
// element with role="img" so it actually replaces the inner text instead of
// being ignored on a bare span.
let accessibleName = $derived(
	isProject
		? $t("instructions.tokenA11y", { name: scope.name ?? "" })
		: $t("instructions.scopeA11y", {
				scope: $t("instructions.scopePersonal"),
			}),
);
</script>

<span
	class={`scope-token scope-token--${size}`}
	data-kind={scope.kind}
	data-testid="scope-token"
	role="img"
	aria-label={accessibleName}
>
	{#if isProject}
		<Folder size={14} strokeWidth={1.75} aria-hidden="true" />
	{:else}
		<User size={14} strokeWidth={1.75} aria-hidden="true" />
	{/if}
	<span class="scope-token__label">{label}</span>
</span>

<style>
	.scope-token {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 7px 1px 5px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		color: var(--text-primary);
		white-space: nowrap;
	}

	.scope-token--sm {
		font-size: var(--text-xs);
	}

	.scope-token--md {
		padding: 3px 10px 3px 7px;
		font-size: var(--text-sm);
	}

	.scope-token :global(svg) {
		flex: 0 0 auto;
		color: var(--accent);
	}

	.scope-token__label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
