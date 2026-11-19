<script lang="ts">
/**
 * Card 1, read aloud: a chat whose last reply is being read. The sentence
 * being read is tinted and the spoken word marked; a few words further down
 * are selected, with "Read from here" over them (under them on a phone); the
 * reply's speaker is a pause in its filling ring; the player sits above the
 * message box.
 */
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnComposer from "$lib/components/drawings/DrawnComposer.svelte";
import DrawnUserMessage from "$lib/components/drawings/DrawnUserMessage.svelte";
import Player from "../parts/Player.svelte";
import ReadFromHere from "../parts/ReadFromHere.svelte";
import ReplyActions from "../parts/ReplyActions.svelte";
import TextLines, { type Line } from "../parts/TextLines.svelte";
import { DESIGN_SIZE, type Variant } from "../sizes";

let { variant }: { variant: Variant } = $props();

let phone = $derived(variant === "mobile");

const DESKTOP_FIRST: Line[] = [
	{ width: "94%", marks: [{ from: 47, to: 94, kind: "sentence" }] },
	{
		width: "97%",
		marks: [
			{ from: 0, to: 97, kind: "sentence" },
			{ from: 31, to: 43, kind: "word" },
		],
	},
	{ width: "62%", marks: [{ from: 0, to: 29, kind: "sentence" }] },
];
const DESKTOP_SECOND: Line[] = [
	{ width: "95%", marks: [{ from: 44, to: 95, kind: "selection" }] },
	{ width: "57%", marks: [{ from: 0, to: 23, kind: "selection" }] },
];
const PHONE_FIRST: Line[] = [
	{ width: "92%" },
	{ width: "96%", marks: [{ from: 38, to: 96, kind: "sentence" }] },
	{
		width: "94%",
		marks: [
			{ from: 0, to: 94, kind: "sentence" },
			{ from: 46, to: 64, kind: "word" },
		],
	},
	{ width: "58%", marks: [{ from: 0, to: 34, kind: "sentence" }] },
];
const PHONE_SECOND: Line[] = [
	{ width: "93%" },
	{ width: "97%", marks: [{ from: 52, to: 97, kind: "selection" }] },
	{ width: "48%", marks: [{ from: 0, to: 30, kind: "selection" }] },
];
</script>

<DrawingFrame width={DESIGN_SIZE[variant].width} height={DESIGN_SIZE[variant].height} bare>
	<div class="chat" class:phone>
		{#if phone}
			<!-- The end of the reply before: its speaker, ready. -->
			<div class="earlier">
				<TextLines lines={[{ width: '90%' }, { width: '46%' }]} />
				<span class="actions"><ReplyActions /></span>
			</div>
		{/if}
		<div class="you"><DrawnUserMessage lines={phone ? ['92%', '54%'] : ['84%']} /></div>
		<div class="reply">
			<span class="dot"></span>
			<div class="paragraphs">
				<TextLines lines={phone ? PHONE_FIRST : DESKTOP_FIRST} />
				<div class="second">
					<TextLines lines={phone ? PHONE_SECOND : DESKTOP_SECOND} />
					<span class="pill"><ReadFromHere /></span>
				</div>
				<span class="actions"><ReplyActions reading progress={42} /></span>
			</div>
		</div>
		<div class="player"><Player {phone} /></div>
		<div class="composer"><DrawnComposer /></div>
	</div>
</DrawingFrame>

<style>
	.chat {
		position: absolute;
		inset: 0;
		background: var(--surface-page);
	}

	.you {
		position: absolute;
		top: calc(var(--u) * 12);
		right: calc(var(--u) * 26);
		width: calc(var(--u) * 116);
	}

	.reply {
		position: absolute;
		top: calc(var(--u) * 40);
		right: calc(var(--u) * 30);
		left: calc(var(--u) * 26);
	}

	/* Where the reply starts: the dot stands for Alfy's mark (`DrawnReply`). */
	.dot {
		position: absolute;
		top: calc(var(--u) * 1);
		left: 0;
		width: calc(var(--u) * 9);
		height: calc(var(--u) * 9);
		border-radius: 50%;
		background: var(--accent);
	}

	.paragraphs {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 7);
		margin-left: calc(var(--u) * 16);
	}

	.second {
		position: relative;
	}

	/* On a desktop the pill floats over the line above the selection. */
	.pill {
		position: absolute;
		top: calc(var(--u) * -13);
		left: 38%;
	}

	.actions {
		display: flex;
		margin-top: calc(var(--u) * -1);
	}

	.player {
		position: absolute;
		right: calc(var(--u) * 40);
		bottom: calc(var(--u) * 48);
		left: calc(var(--u) * 40);
	}

	.composer {
		position: absolute;
		right: calc(var(--u) * 22);
		bottom: calc(var(--u) * 10);
		left: calc(var(--u) * 22);
	}

	/* A phone: one column from edge to edge, the pill under the selection,
	   the player in two rows. */
	.earlier {
		position: absolute;
		top: calc(var(--u) * 8);
		right: calc(var(--u) * 12);
		left: calc(var(--u) * 24);
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 4);
	}

	.phone .you {
		top: calc(var(--u) * 58);
		right: calc(var(--u) * 10);
		width: calc(var(--u) * 116);
	}

	.phone .reply {
		top: calc(var(--u) * 104);
		right: calc(var(--u) * 12);
		left: calc(var(--u) * 10);
	}

	.phone .paragraphs {
		gap: calc(var(--u) * 9);
		margin-left: calc(var(--u) * 14);
	}

	.phone .pill {
		top: auto;
		bottom: calc(var(--u) * -17);
		left: 22%;
	}

	.phone .actions {
		margin-top: calc(var(--u) * 16);
	}

	.phone .player {
		right: calc(var(--u) * 8);
		bottom: calc(var(--u) * 50);
		left: calc(var(--u) * 8);
	}

	.phone .composer {
		right: calc(var(--u) * 8);
		bottom: calc(var(--u) * 10);
		left: calc(var(--u) * 8);
	}
</style>
