<script lang="ts">
/**
 * Read aloud on a standard report in the panel's preview (spec §4.12): the page's
 * half of the report bridge (`$lib/client/read-aloud/report-bridge-host.ts`; the
 * frame's half is `report-bridge.ts`). The report's frame stays opaque, so:
 *
 * - what is read is the page's own inert copy of the report (`makeReportCopy`), and
 *   the panel gets the source the controller reads it through (`onSource`);
 * - the marks and the scroll to the sentence are sent to the frame as places, and
 *   the frame draws them;
 * - where the reader selects text in the frame, the frame says only where, and the
 *   page shows its own Read from here there. Only a press on that control, in the
 *   page, starts a reading: nothing the frame says starts, resumes or moves one.
 *
 * Nothing the frame says is taken before it has said it found the same units as the
 * page's copy (`ready`), and nothing from any other window is taken at all.
 */
import { Play } from "@lucide/svelte";
import {
	getReadAloud,
	type ReadAloudController,
	type ReportReadingSource,
	reportReadingKey,
} from "$lib/client/read-aloud/controller";
import {
	makeReportCopy,
	marksMessage,
	postToFrame,
	readFrameMessage,
	spansOf,
} from "$lib/client/read-aloud/report-bridge-host";
import {
	pointInBlocks,
	REPORT_CHROME,
} from "$lib/client/read-aloud/report-units";
import { t } from "$lib/i18n";
import { type ReadAloudView, readAloudView } from "$lib/stores/read-aloud";

let {
	frame,
	html,
	fileId,
	onSource,
	controller = undefined,
}: {
	/** The report's frame: an opaque srcdoc frame that carries the bridge. */
	frame: HTMLIFrameElement;
	/** The report's HTML, as the preview was given it: the page's copy is made from it. */
	html: string;
	/** The chat file the report is: what the session route is asked for. */
	fileId: string;
	/** Hands the panel the source its speaker reads, and null once it is gone. */
	onSource: (source: ReportReadingSource | null) => void;
	controller?: ReadAloudController;
} = $props();

const reader = () => controller ?? getReadAloud();

/** The control keeps this far from the selection, and this far inside the frame. */
const GAP_PX = 8;
const EDGE_PX = 8;

const copy = $derived(makeReportCopy(html));
const key = $derived(reportReadingKey(fileId));

/** The frame said it found the units the page's copy has: until then nothing it says is taken. */
let agreed = $state(false);
let alive = true;
/** The last marks sent, so a view that moves only its clock sends nothing. */
let lastSent = "";

type Selected = {
	block: number;
	offset: number;
	rect: { x: number; y: number; width: number; height: number };
};
let selected = $state<Selected | null>(null);
let pill = $state<HTMLButtonElement | null>(null);
let place = $state<{ top: number; left: number } | null>(null);
/**
 * A press counts once the pointer has come to the control (or a finger or a key
 * presses it): the frame says where it goes, and a control that appears under a
 * pointer that is already pressing would otherwise take a press meant for the report.
 */
let armed = $state(false);

const source: ReportReadingSource = {
	root: () => (alive ? copy.root : null),
	skip: REPORT_CHROME,
	revision: () => copy,
	focus(ranges, mode) {
		if (!alive || !agreed) return;
		const spans = spansOf(copy, ranges);
		if (spans.length > 0) postToFrame(frame, { type: "focus", spans, mode });
	},
};

$effect(() => {
	const hand = onSource;
	hand(source);
	return () => hand(null);
});

$effect(() => {
	return () => {
		alive = false;
		postToFrame(frame, { type: "clear" });
	};
});

// A new copy (another report in the same frame) or a frame that loads asks the bridge again.
$effect(() => {
	const target = frame;
	void copy;
	agreed = false;
	selected = null;
	lastSent = "";
	const hello = () => postToFrame(target, { type: "hello" });
	hello();
	target.addEventListener("load", hello);
	return () => target.removeEventListener("load", hello);
});

$effect(() => {
	const listen = (event: MessageEvent) => {
		const said = readFrameMessage(event, frame, copy);
		if (!said) return;
		if (said.type === "ready") {
			agreed = said.blocks === copy.blocks.length && said.chars === copy.chars;
			lastSent = "";
			if (!agreed) selected = null;
			return;
		}
		if (!agreed) return;
		if (said.type === "deselect") {
			selected = null;
			return;
		}
		selected = { block: said.block, offset: said.offset, rect: said.rect };
		armed = false;
	};
	window.addEventListener("message", listen);
	return () => window.removeEventListener("message", listen);
});

// Each part of the view the marks read, apart: a view that moves only its progress
// leaves them as they were, and nothing is worked out or sent again.
const status = $derived($readAloudView.status);
const viewKey = $derived($readAloudView.key);
const marks = $derived($readAloudView.marks);
const drag = $derived($readAloudView.drag);
const marksToSend = $derived(
	marksMessage(
		{ status, key: viewKey, marks, drag } as ReadAloudView,
		key,
		copy,
	),
);

$effect(() => {
	const next = marksToSend;
	if (!agreed) return;
	const sent = JSON.stringify(next);
	if (sent === lastSent) return;
	lastSent = sent;
	postToFrame(frame, next);
});

/**
 * Above the selection's box, or below it on a touch screen, whose own menu takes the
 * space above; on the other side when its own has no room; inside the frame, and
 * not at all while the selection is scrolled out of it.
 */
$effect(() => {
	const current = selected;
	if (!current) {
		place = null;
		return;
	}
	const width = pill?.offsetWidth ?? 0;
	const height = pill?.offsetHeight ?? 0;
	const areaWidth = frame.clientWidth;
	const areaHeight = frame.clientHeight;
	const { x, y, height: boxHeight } = current.rect;
	if (areaHeight > 0 && (y + boxHeight < 0 || y > areaHeight)) {
		place = null;
		return;
	}
	const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
	const above = y - GAP_PX - height;
	const below = y + boxHeight + GAP_PX;
	const roomAbove = above >= EDGE_PX;
	const roomBelow = below + height <= areaHeight - EDGE_PX;
	const top = coarse
		? roomBelow || !roomAbove
			? below
			: above
		: roomAbove || !roomBelow
			? above
			: below;
	const clamp = (value: number, min: number, max: number) =>
		Math.max(min, Math.min(value, Math.max(min, max)));
	place = {
		top: frame.offsetTop + clamp(top, EDGE_PX, areaHeight - EDGE_PX - height),
		left: frame.offsetLeft + clamp(x, EDGE_PX, areaWidth - EDGE_PX - width),
	};
});

function press(event: MouseEvent) {
	// A keyboard's click (detail 0) is always deliberate.
	if (!armed && event.detail !== 0) return;
	const current = selected;
	if (!current || !agreed) return;
	const from = pointInBlocks(copy.blocks, current.block, current.offset);
	if (!from) return;
	selected = null;
	reader().start({
		kind: "report",
		fileId,
		source,
		from: { node: from.node, offset: from.offset },
	});
}
</script>

{#if selected}
	<button
		bind:this={pill}
		type="button"
		class="read-from-here report-read-from-here"
		class:placed={place !== null}
		style:top="{place?.top ?? 0}px"
		style:left="{place?.left ?? 0}px"
		data-testid="report-read-from-here"
		onpointermove={() => (armed = true)}
		onpointerdown={(event) => {
			if (event.pointerType !== "mouse") armed = true;
		}}
		onclick={press}
	>
		<Play size={13} strokeWidth={2.5} aria-hidden="true" />
		<span>{$t("readAloud.readFromHere")}</span>
	</button>
{/if}

<style>
	/* The reply's Read from here (`ReadFromHere.svelte`), over the report's frame. */
	.read-from-here {
		position: absolute;
		z-index: 2;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 12px 0 10px;
		border: 0;
		border-radius: 999px;
		background: var(--read-aloud-chip-bg);
		color: var(--read-aloud-chip-fg);
		box-shadow: var(--shadow-lg);
		font-family: var(--font-sans);
		font-size: 12.5px;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		visibility: hidden;
	}

	.read-from-here.placed {
		visibility: visible;
		animation: report-read-from-here-in var(--duration-standard) var(--ease-out);
	}

	.read-from-here:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
	}

	@keyframes report-read-from-here-in {
		from {
			opacity: 0;
			transform: translateY(3px);
		}
	}
</style>
