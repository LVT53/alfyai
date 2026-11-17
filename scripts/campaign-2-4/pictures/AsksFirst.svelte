<script lang="ts">
/**
 * Card 3, Alfy asks first: a reply that stopped to ask, with its question
 * card, and the message box off while the question waits. On a desktop the
 * sidebar shows the chat's question mark (`ConversationItem.svelte`, Lucide
 * `MessageCircleQuestionMark` in the accent, no words).
 */
import { MessageCircleQuestionMark } from "@lucide/svelte";
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";
import DrawnComposer from "$lib/components/drawings/DrawnComposer.svelte";
import DrawnUserMessage from "$lib/components/drawings/DrawnUserMessage.svelte";
import QuestionCard from "../parts/QuestionCard.svelte";
import { DESIGN_SIZE, type Variant } from "../sizes";

let { variant }: { variant: Variant } = $props();

let phone = $derived(variant === "mobile");

const ROWS = ["64%", "72%", "52%", "68%", "46%", "58%"];
</script>

<DrawingFrame width={DESIGN_SIZE[variant].width} height={DESIGN_SIZE[variant].height} bare>
	<div class="screen" class:phone>
		{#if !phone}
			<div class="sidebar">
				{#each ROWS as width, index}
					<span class="row" class:current={index === 1}>
						{#if index === 1}
							<span class="drawn-ic waiting" style:--ic="8"><MessageCircleQuestionMark size="100%" strokeWidth={2.2} aria-hidden="true" /></span>
						{/if}
						<DrawnBar {width} tone={index === 1 ? 'strong' : 'soft'} />
					</span>
				{/each}
			</div>
		{/if}
		<div class="chat">
			<div class="you"><DrawnUserMessage lines={phone ? ['90%', '48%'] : ['80%']} /></div>
			<div class="reply">
				<span class="dot"></span>
				<div class="text">
					<DrawnBar width="88%" tone="soft" />
					<DrawnBar width="54%" tone="soft" />
				</div>
			</div>
			<div class="card"><QuestionCard /></div>
			<div class="composer"><DrawnComposer /></div>
		</div>
	</div>
</DrawingFrame>

<style>
	.screen {
		position: absolute;
		inset: 0;
		display: flex;
		background: var(--surface-page);
	}

	.sidebar {
		display: flex;
		flex: none;
		flex-direction: column;
		gap: calc(var(--u) * 3);
		width: calc(var(--u) * 84);
		padding: calc(var(--u) * 26) calc(var(--u) * 6) 0;
		border-right: 1px solid var(--border-default);
		background: var(--surface-elevated);
		box-sizing: border-box;
	}

	.row {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
		height: calc(var(--u) * 14);
		padding: 0 calc(var(--u) * 5);
		border-radius: calc(var(--u) * 4);
	}

	.row.current {
		background: color-mix(in srgb, var(--text-primary) 6%, transparent);
	}

	.waiting {
		color: var(--accent);
	}

	.chat {
		position: relative;
		flex: 1;
	}

	.you {
		position: absolute;
		top: calc(var(--u) * 10);
		right: calc(var(--u) * 22);
		width: calc(var(--u) * 104);
	}

	.reply {
		position: absolute;
		top: calc(var(--u) * 32);
		right: calc(var(--u) * 26);
		left: calc(var(--u) * 20);
	}

	.dot {
		position: absolute;
		top: 0;
		left: 0;
		width: calc(var(--u) * 9);
		height: calc(var(--u) * 9);
		border-radius: 50%;
		background: var(--accent);
	}

	.text {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 5);
		margin-left: calc(var(--u) * 16);
		padding-top: calc(var(--u) * 2);
	}

	.card {
		position: absolute;
		top: calc(var(--u) * 54);
		right: calc(var(--u) * 26);
		left: calc(var(--u) * 36);
	}

	/* While a question waits the message box is off: its surface stays, what
	   it holds is dimmed. */
	.composer {
		position: absolute;
		right: calc(var(--u) * 16);
		bottom: calc(var(--u) * 7);
		left: calc(var(--u) * 16);
		opacity: 0.55;
	}

	.phone .you {
		top: calc(var(--u) * 18);
		right: calc(var(--u) * 10);
		width: calc(var(--u) * 116);
	}

	.phone .reply {
		top: calc(var(--u) * 70);
		right: calc(var(--u) * 12);
		left: calc(var(--u) * 10);
	}

	.phone .card {
		top: calc(var(--u) * 100);
		right: calc(var(--u) * 10);
		left: calc(var(--u) * 10);
	}

	.phone .composer {
		right: calc(var(--u) * 8);
		bottom: calc(var(--u) * 10);
		left: calc(var(--u) * 8);
	}
</style>
