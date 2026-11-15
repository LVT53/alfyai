// A timing probe, not a test: it drives ONE real picture turn through the fake
// provider (the app's own `make_image` call) and a fake ComfyUI set to a known
// render time, then prints when each step of the chain happened, so the
// seconds between "the picture server finished" and "the picture is visible"
// can be attributed to a segment instead of guessed at.
//
// It is INERT everywhere else. The release gate, the smoke tier and every
// normal run skip it at collection time (one line, no page, no server call):
//
//   IMAGE_TIMING=1 npx playwright test tests/e2e/images-take-timing.spec.ts \
//     --project=chromium --reporter=line --workers=1
//
// `IMAGE_TIMING_BYTES=1` runs the second probe instead: the same turn with a
// LARGE fake picture (2048 x 2048, a few MB), a DPR-2 1280 x 900 page and a
// 400 ms / 51 200 B/s CDP network throttle, recording which picture URL the
// card requests, the response's transfer size and the time from the take
// settling to the <img> decoded. That is the before/after evidence for the
// display-variant download fix.
//
// Measurement only: it changes no application code. It reads the slot's e2e
// SQLite file directly (the same `db` the other specs import), samples the
// DOM every ~100 ms from the page's own clock, and watches the
// `/api/conversations/<id>` reads with `page.on("response")`. The table it
// prints is the evidence behind
// docs/plans/perf-load-2026-11/image-timing-<date>.md.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	imageCards,
	imageFiles,
	imageJobs,
	messages,
} from "../../src/lib/server/db/schema";
import {
	AI_SMOKE_MAKE_IMAGE_FINAL_TEXT,
	AI_SMOKE_MAKE_IMAGE_MARKER,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createEmptyConversation,
	login,
	sendMessage,
	waitForHydration,
} from "./helpers";
import {
	type FakeComfyUi,
	largePng,
	releaseSpecChatModel,
	startFakeComfyUiForSpec,
	stopFakeComfyUiForSpec,
	submittedPrompts,
	useSpecChatModel,
} from "./images-helpers";

const TIMELINE = Boolean(process.env.IMAGE_TIMING);
const BYTES = Boolean(process.env.IMAGE_TIMING_BYTES);
test.skip(
	!TIMELINE && !BYTES,
	"timing probe: set IMAGE_TIMING=1 (timeline) or IMAGE_TIMING_BYTES=1 (download)",
);

const PROVIDER_PREFIX = "images_timing_";
/** The fake provider's own call id for `make_image` (tests/mocks/ai-provider/openai-compatible-provider.ts). */
const CALL_ID = "call_fake_make_image";
/** A known render: 4 steps x 500 ms = 2 s inside the fake, before it answers. */
const FAKE_STEPS = 4;
const FAKE_STEP_DELAY_MS = 500;
const SAMPLE_INTERVAL_MS = 100;
const TURN_MAX_MS = 60_000;
const CARD =
	'[data-testid="message-deliverables"] [data-testid="artifact-card"]';

// ------------------------------------------------------------------ sampling

type DomSample = {
	/** `Date.now()` in the page, just before the DOM was read. */
	at: number;
	card: boolean;
	state: string | null;
	picture: boolean;
	imgLoaded: boolean;
	naturalWidth: number;
	toolStatus: string | null;
	finalText: boolean;
	/** The reply's own end: `MessageBubble` draws its action row only once the message stops streaming. */
	replyEnded: boolean;
};

async function sampleDom(page: Page): Promise<DomSample> {
	return page.evaluate(
		({ cardSelector, callId, finalText }) => {
			const card = document.querySelector(cardSelector);
			const body = card?.querySelector('[data-testid="image-card-body"]');
			const picture = card?.querySelector('[data-testid="image-card-picture"]');
			// `image-picture-after` IS the <img> (ImagePicture.svelte puts the
			// testid on the element itself, not on a wrapper).
			const img = card?.querySelector(
				'img[data-testid="image-picture-after"]',
			) as HTMLImageElement | null;
			// The row's `data-activity-key` sits on the `.act-entry` around it,
			// not on the row button.
			const row = document.querySelector(
				`[data-activity-key="${callId}"] [data-testid="tool-activity-row"]`,
			);
			const assistantMessages = [
				...document.querySelectorAll('[data-testid="assistant-message"]'),
			];
			return {
				at: Date.now(),
				card: card !== null,
				state: body?.getAttribute("data-state") ?? null,
				picture: picture !== null,
				imgLoaded: img?.classList.contains("is-loaded") ?? false,
				naturalWidth: img?.naturalWidth ?? 0,
				toolStatus: row?.getAttribute("data-status") ?? null,
				finalText: assistantMessages.some(
					(node) => node.textContent?.includes(finalText) ?? false,
				),
				replyEnded: assistantMessages.some(
					(node) => node.querySelector(".message-actions") !== null,
				),
			};
		},
		{
			cardSelector: CARD,
			callId: CALL_ID,
			finalText: AI_SMOKE_MAKE_IMAGE_FINAL_TEXT,
		},
	);
}

type DbJob = {
	id: string;
	status: string;
	phase: string | null;
	phaseAt: number | null;
	createdAt: number | null;
	startedAt: number | null;
	completedAt: number | null;
	resultFileId: string | null;
	heldUntil: number | null;
	errorCode: string | null;
};
type DbCard = {
	id: string;
	pickedTakeId: string | null;
	artifactId: string | null;
	createdAt: number | null;
};
type DbFile = {
	id: string;
	storagePath: string;
	onDisk: boolean;
	createdAt: number | null;
};
type DbReply = { id: string; createdAt: number | null };
type DbSample = {
	/** `Date.now()` in the spec, just before the read. */
	at: number;
	job: DbJob | null;
	card: DbCard | null;
	file: DbFile | null;
	/** The reply's durable row: it exists only once the turn persisted its answer. */
	reply: DbReply | null;
};

function ms(value: Date | null): number | null {
	return value === null ? null : value.getTime();
}

async function sampleDb(conversationId: string): Promise<DbSample> {
	const [jobRow] = await db
		.select()
		.from(imageJobs)
		.where(eq(imageJobs.conversationId, conversationId))
		.orderBy(asc(imageJobs.createdAt))
		.limit(1);
	const [cardRow] = await db
		.select()
		.from(imageCards)
		.where(eq(imageCards.conversationId, conversationId))
		.orderBy(asc(imageCards.createdAt))
		.limit(1);
	const [replyRow] = await db
		.select({ id: messages.id, createdAt: messages.createdAt })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.role, "assistant"),
			),
		)
		.orderBy(desc(messages.createdAt))
		.limit(1);
	let fileRow: DbFile | null = null;
	if (jobRow?.resultFileId) {
		const [row] = await db
			.select()
			.from(imageFiles)
			.where(eq(imageFiles.id, jobRow.resultFileId))
			.limit(1);
		if (row) {
			fileRow = {
				id: row.id,
				storagePath: row.storagePath,
				onDisk: existsSync(join(process.cwd(), row.storagePath)),
				createdAt: ms(row.createdAt),
			};
		}
	}
	return {
		at: Date.now(),
		job: jobRow
			? {
					id: jobRow.id,
					status: jobRow.status,
					phase: jobRow.phase,
					phaseAt: jobRow.phaseAt,
					createdAt: ms(jobRow.createdAt),
					startedAt: ms(jobRow.startedAt),
					completedAt: ms(jobRow.completedAt),
					resultFileId: jobRow.resultFileId,
					heldUntil: jobRow.heldUntil,
					errorCode: jobRow.errorCode,
				}
			: null,
		card: cardRow
			? {
					id: cardRow.id,
					pickedTakeId: cardRow.pickedTakeId,
					artifactId: cardRow.artifactId,
					createdAt: ms(cardRow.createdAt),
				}
			: null,
		file: fileRow,
		reply: replyRow
			? { id: replyRow.id, createdAt: ms(replyRow.createdAt) }
			: null,
	};
}

type FakeSample = {
	at: number;
	submitted: number;
	promptStatus: string | null;
};

function sampleFake(fake: FakeComfyUi): FakeSample {
	const prompts = submittedPrompts(fake);
	const promptId = prompts[0]?.promptId;
	return {
		at: Date.now(),
		submitted: prompts.length,
		promptStatus: promptId ? (fake.prompts.get(promptId) ?? null) : null,
	};
}

type DetailRead = {
	startedAt: number;
	at: number;
	status: number;
	/** null when the body could not be read back (a response already gone). */
	hasCard: boolean | null;
	cards: number | null;
	pickedTakeId: string | null;
	takeStatus: string | null;
	takeHeld: boolean | null;
	takeFileId: string | null;
};

function detailPath(conversationId: string): string {
	return `/api/conversations/${conversationId}`;
}

// --------------------------------------------------------------------- probe

if (TIMELINE) {
	test("where the seconds between the picture server and the picture go", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		const fakeProvider = createOpenAICompatibleProviderHarness();
		let fake: FakeComfyUi | null = null;
		let model: Awaited<ReturnType<typeof useSpecChatModel>> | null = null;
		let conversationId: string | null = null;
		try {
			await fakeProvider.start();
			await fakeProvider.reset();
			await login(page);
			model = await useSpecChatModel(
				page,
				fakeProvider.baseURL,
				PROVIDER_PREFIX,
			);
			fake = await startFakeComfyUiForSpec(page);
			fake.setOptions({
				steps: FAKE_STEPS,
				stepDelayMs: FAKE_STEP_DELAY_MS,
			});
			conversationId = await createEmptyConversation(page);

			// Network witnesses, attached before the chat is opened so the first
			// detail read of a later turn cannot be missed.
			const detailStarts = new WeakMap<object, number>();
			const detailReads: DetailRead[] = [];
			let streamStartedAt: number | null = null;
			let streamFinishedAt: number | null = null;
			let releaseStreamFinished: (() => void) | null = null;
			const streamFinished = new Promise<void>((resolve) => {
				releaseStreamFinished = resolve;
			});
			const isDetailRequest = (request: {
				method(): string;
				url(): string;
			}): boolean =>
				request.method() === "GET" &&
				new URL(request.url()).pathname ===
					detailPath(conversationId as string);
			const onRequest = (request: import("@playwright/test").Request) => {
				if (isDetailRequest(request)) detailStarts.set(request, Date.now());
				if (
					request.method() === "POST" &&
					new URL(request.url()).pathname === "/api/chat/stream" &&
					streamStartedAt === null
				) {
					streamStartedAt = Date.now();
				}
			};
			const onResponse = (response: import("@playwright/test").Response) => {
				const request = response.request();
				if (!isDetailRequest(request)) return;
				const startedAt = detailStarts.get(request) ?? Date.now();
				const status = response.status();
				void response
					.json()
					.then((body: unknown) => {
						const payload = body as {
							imageCards?: Array<{
								pickedTakeId?: string | null;
								takes?: Array<{
									status?: string;
									held?: boolean;
									fileId?: string | null;
								}>;
							}>;
						};
						const cards = Array.isArray(payload.imageCards)
							? payload.imageCards
							: [];
						const first = cards[0];
						detailReads.push({
							startedAt,
							at: Date.now(),
							status,
							hasCard: cards.length > 0,
							cards: cards.length,
							pickedTakeId: first?.pickedTakeId ?? null,
							takeStatus: first?.takes?.[0]?.status ?? null,
							takeHeld: first?.takes?.[0]?.held ?? null,
							takeFileId: first?.takes?.[0]?.fileId ?? null,
						});
					})
					.catch(() => {
						detailReads.push({
							startedAt,
							at: Date.now(),
							status,
							hasCard: null,
							cards: null,
							pickedTakeId: null,
							takeStatus: null,
							takeHeld: null,
							takeFileId: null,
						});
					});
			};
			const onRequestFinished = (
				request: import("@playwright/test").Request,
			) => {
				if (
					request.method() === "POST" &&
					new URL(request.url()).pathname === "/api/chat/stream" &&
					streamFinishedAt === null
				) {
					streamFinishedAt = Date.now();
					releaseStreamFinished?.();
				}
			};
			page.on("request", onRequest);
			page.on("response", onResponse);
			page.on("requestfinished", onRequestFinished);

			await page.goto(`/chat/${conversationId}`, {
				waitUntil: "domcontentloaded",
			});
			await waitForHydration(page);
			await expect(page.getByTestId("message-input")).toBeVisible();
			await expect(page.getByTestId("message-input")).toBeEnabled();

			const domSamples: DomSample[] = [];
			const dbSamples: DbSample[] = [];
			const fakeSamples: FakeSample[] = [];
			// Page clock vs spec clock, sampled every tick: a picture's DOM times are
			// only comparable with the server's `phase_at` if this stays near zero.
			const clockSkewMs: number[] = [];
			const turnStart = Date.now();
			let stop = false;
			let loopError: unknown = null;
			const runningFake = fake;
			// Keep sampling this long after the picture first shows, so a late
			// detail read, the reply's own finish and the durable reply row are seen.
			const SETTLE_AFTER_VISIBLE_MS = 1_500;
			let visibleAt: number | null = null;
			const poll = (async () => {
				while (!stop) {
					const tick = Date.now();
					try {
						const dom = await sampleDom(page);
						clockSkewMs.push(Date.now() - dom.at);
						domSamples.push(dom);
						dbSamples.push(await sampleDb(conversationId as string));
						fakeSamples.push(sampleFake(runningFake));
					} catch (error) {
						if (!stop) loopError = error;
						break;
					}
					const last = domSamples[domSamples.length - 1];
					if (last?.imgLoaded && last.naturalWidth > 0) {
						visibleAt ??= last.at;
					}
					if (
						visibleAt !== null &&
						Date.now() - visibleAt >= SETTLE_AFTER_VISIBLE_MS
					) {
						break;
					}
					if (Date.now() - turnStart > TURN_MAX_MS) break;
					const elapsed = Date.now() - tick;
					await new Promise((resolve) =>
						setTimeout(resolve, Math.max(20, SAMPLE_INTERVAL_MS - elapsed)),
					);
				}
			})();

			try {
				await sendMessage(page, AI_SMOKE_MAKE_IMAGE_MARKER);
				await poll;
				// The reply's stream closes just after its picture's card settles: give
				// the network witness a bounded moment to arrive before the listeners go.
				await Promise.race([
					streamFinished,
					new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
				]);
			} finally {
				stop = true;
				await poll.catch(() => undefined);
			}
			page.off("request", onRequest);
			page.off("response", onResponse);
			page.off("requestfinished", onRequestFinished);

			if (loopError) throw loopError;

			// ------------------------------------------------------------ events
			type EventRow = {
				label: string;
				at: number | null;
				note: string;
			};
			const firstDom = (predicate: (sample: DomSample) => boolean) => {
				const found = domSamples.find(predicate);
				return found ? found.at : null;
			};
			const firstDb = (predicate: (sample: DbSample) => boolean) => {
				const found = dbSamples.find(predicate);
				return found ? found.at : null;
			};
			const firstFake = (predicate: (sample: FakeSample) => boolean) => {
				const found = fakeSamples.find(predicate);
				return found ? found.at : null;
			};

			const firstJob = dbSamples.find((sample) => sample.job)?.job ?? null;
			const firstReply =
				dbSamples.find((sample) => sample.reply)?.reply ?? null;
			const lastDb = dbSamples[dbSamples.length - 1] ?? null;
			const job = lastDb?.job ?? null;
			const phaseEvents: Array<{ phase: string; at: number; phaseAt: number }> =
				[];
			let lastPhase: string | null = null;
			for (const sample of dbSamples) {
				const phase = sample.job?.phase ?? null;
				if (phase !== null && phase !== lastPhase) {
					lastPhase = phase;
					phaseEvents.push({
						phase,
						at: sample.at,
						phaseAt: sample.job?.phaseAt ?? sample.at,
					});
				}
			}
			const releaseAt = firstDb(
				(sample) => sample.job !== null && sample.job.heldUntil === null,
			);
			const events: EventRow[] = [
				{
					label: "SEND pressed",
					at: turnStart,
					note: "spec, the click that starts the turn",
				},
				{
					label: "stream: POST /api/chat/stream starts",
					at: streamStartedAt,
					note: "network, request event",
				},
				{
					label: "fake ComfyUI: POST /prompt received",
					at: firstFake((sample) => sample.submitted > 0),
					note: "spec poll of the fake's requests (~100 ms)",
				},
				{
					label: "image_jobs row exists",
					at: firstDb((sample) => sample.job !== null),
					note: `created_at ${
						firstJob?.createdAt
							? new Date(firstJob.createdAt).toISOString()
							: "?"
					} (unix seconds)`,
				},
				...phaseEvents.map((phase) => ({
					label: `image_jobs.phase = ${phase.phase}`,
					at: phase.at,
					note: `phase_at ${new Date(phase.phaseAt).toISOString()}`,
				})),
				{
					label: "fake ComfyUI: prompt done",
					at: firstFake((sample) => sample.promptStatus === "done"),
					note: "the fake finishes its last step + render, sends execution_success",
				},
				{
					label: "image_jobs.status = succeeded",
					at: firstDb((sample) => sample.job?.status === "succeeded"),
					note: `completed_at ${
						job?.completedAt
							? new Date(job.completedAt).toISOString()
							: "(not read)"
					}`,
				},
				{
					label: "image_jobs.result_file_id set",
					at: firstDb((sample) => Boolean(sample.job?.resultFileId)),
					note: "the PNG row exists",
				},
				{
					label: "picture file on disk",
					at: firstDb((sample) => sample.file?.onDisk === true),
					note: "existsSync on data/image-files/...",
				},
				{
					label: "image_jobs.held_until = null (released)",
					at: releaseAt,
					note: "the tool call's releaseHold; the card may settle now",
				},
				{
					label: "image_cards.picked_take_id set",
					at: firstDb((sample) => Boolean(sample.card?.pickedTakeId)),
					note: "the card's pick",
				},
				{
					label: "STREAM: make_image row is running",
					at: firstDom((sample) => sample.toolStatus === "running"),
					note: "DOM, the tool row's data-status",
				},
				{
					label: "STREAM: make_image row is done",
					at: firstDom((sample) => sample.toolStatus === "done"),
					note: "DOM, the tool result reached the reply",
				},
				{
					label: "STREAM: assistant final text visible",
					at: firstDom((sample) => sample.finalText),
					note: `"${AI_SMOKE_MAKE_IMAGE_FINAL_TEXT}"`,
				},
				{
					label: "STREAM: assistant reply finished (action row appears)",
					at: firstDom((sample) => sample.replyEnded),
					note: "DOM, MessageBubble draws .message-actions only once the message stops streaming",
				},
				{
					label: "SERVER: assistant reply persisted (messages row)",
					at: firstDb((sample) => sample.reply !== null),
					note: `created_at ${
						firstReply?.createdAt
							? new Date(firstReply.createdAt).toISOString()
							: "?"
					} (unix seconds)`,
				},
				{
					label: "stream: POST /api/chat/stream finished",
					at: streamFinishedAt,
					note: "network, the response body ended",
				},
				{
					label: "CLIENT: card element appears",
					at: firstDom((sample) => sample.card),
					note: "the artifact-card in message-deliverables",
				},
				{
					label: "CLIENT: card state = ready (real take, not placeholder)",
					at: firstDom((sample) => sample.state === "ready"),
					note: "image-card-body[data-state] and image-card-picture",
				},
				{
					label: "CLIENT: <img> loaded (naturalWidth > 0)",
					at: firstDom((sample) => sample.imgLoaded && sample.naturalWidth > 0),
					note: "the browser decoded the PNG",
				},
			];

			const at = (label: string): number | null =>
				events.find((event) => event.label === label)?.at ?? null;
			const gap = (from: number | null, to: number | null): string =>
				from !== null && to !== null ? `${to - from} ms` : "not measured";
			const fakeDoneAt = at("fake ComfyUI: prompt done");
			const toolDoneAt = at("STREAM: make_image row is done");
			const cardAt = at("CLIENT: card element appears");
			const readyAt = at(
				"CLIENT: card state = ready (real take, not placeholder)",
			);
			const imgAt = at("CLIENT: <img> loaded (naturalWidth > 0)");

			// ------------------------------------------------------------- table
			const clock = (value: number): string => {
				const date = new Date(value);
				const hh = String(date.getHours()).padStart(2, "0");
				const mm = String(date.getMinutes()).padStart(2, "0");
				const ss = String(date.getSeconds()).padStart(2, "0");
				const mmm = String(date.getMilliseconds()).padStart(3, "0");
				return `${hh}:${mm}:${ss}.${mmm}`;
			};
			console.log(
				"\n=== picture timing: one turn, fake ComfyUI 4 x 500 ms ===",
			);
			console.log(
				`conversation ${conversationId}, samples ${domSamples.length} DOM / ${dbSamples.length} DB / ${fakeSamples.length} fake, interval ~${SAMPLE_INTERVAL_MS} ms`,
			);
			if (clockSkewMs.length > 0) {
				console.log(
					`page-vs-spec clock skew: min ${Math.min(...clockSkewMs)} ms, max ${Math.max(...clockSkewMs)} ms (half a sampling round-trip included)`,
				);
			}
			console.log("event | t+ms | clock | source");
			for (const event of events) {
				console.log(
					`${event.label} | ${
						event.at === null ? "—" : String(event.at - turnStart)
					} | ${event.at === null ? "—" : clock(event.at)} | ${event.note}`,
				);
			}

			console.log("\n=== gaps ===");
			for (const [from, to] of [
				["fake ComfyUI: prompt done", "image_jobs.status = succeeded"],
				[
					"fake ComfyUI: prompt done",
					"image_jobs.held_until = null (released)",
				],
				["fake ComfyUI: prompt done", "image_cards.picked_take_id set"],
				["fake ComfyUI: prompt done", "STREAM: make_image row is done"],
				["fake ComfyUI: prompt done", "CLIENT: card element appears"],
				[
					"fake ComfyUI: prompt done",
					"CLIENT: card state = ready (real take, not placeholder)",
				],
				[
					"fake ComfyUI: prompt done",
					"CLIENT: <img> loaded (naturalWidth > 0)",
				],
				["STREAM: make_image row is done", "CLIENT: card element appears"],
				[
					"CLIENT: card element appears",
					"CLIENT: card state = ready (real take, not placeholder)",
				],
				[
					"CLIENT: card state = ready (real take, not placeholder)",
					"CLIENT: <img> loaded (naturalWidth > 0)",
				],
			] as const) {
				console.log(`${from} -> ${to}: ${gap(at(from), at(to))}`);
			}
			// The server's own clock, not a ~100 ms sample: the runner enters
			// `finishing` the moment the follow sees the prompt complete, so this is
			// the tightest "the picture server finished" stamp the probe can show.
			const finishing = phaseEvents.find(
				(phase) => phase.phase === "finishing",
			);
			if (finishing) {
				console.log(
					`server clock: phase_at(finishing) t+${
						finishing.phaseAt - turnStart
					} -> card element ${gap(finishing.phaseAt, cardAt)} -> <img> loaded ${gap(
						finishing.phaseAt,
						imgAt,
					)}`,
				);
			}

			console.log("\n=== detail reads (/api/conversations/<id>) ===");
			if (detailReads.length === 0) {
				console.log("none");
			} else {
				console.log(
					"# | start t+ | end t+ | ms | status | cards | has card | picked take | take status | held | file",
				);
				detailReads
					.sort((a, b) => a.startedAt - b.startedAt)
					.forEach((read, index) => {
						const between =
							cardAt !== null &&
							read.startedAt <= cardAt &&
							(releaseAt === null || read.at >= releaseAt)
								? " [between settle and card]"
								: "";
						console.log(
							`${index + 1} | ${read.startedAt - turnStart} | ${
								read.at - turnStart
							} | ${read.at - read.startedAt} | ${read.status} | ${
								read.cards ?? "?"
							} | ${read.hasCard === null ? "unreadable" : read.hasCard} | ${
								read.pickedTakeId ?? "—"
							} | ${read.takeStatus ?? "—"} | ${
								read.takeHeld === null ? "—" : read.takeHeld
							} | ${read.takeFileId ?? "—"}${between}`,
						);
					});
			}

			console.log("\n=== job phases over time (DB) ===");
			for (const phase of phaseEvents) {
				console.log(
					`phase ${phase.phase} observed t+${phase.at - turnStart} (phase_at ${
						phase.phaseAt - turnStart
					})`,
				);
			}

			// Every change the spec process saw, in the order it saw it: this is what
			// makes a lag between the server's own clock (phase_at / held_until) and
			// the sample that noticed it visible instead of guessed at.
			console.log("\n=== DB transitions (one row per change) ===");
			let previousDb = "";
			for (const sample of dbSamples) {
				if (!sample.job && !sample.card) continue;
				const signature = JSON.stringify([
					sample.job?.status,
					sample.job?.phase,
					sample.job?.phaseAt,
					sample.job?.heldUntil,
					sample.job?.resultFileId,
					sample.card?.pickedTakeId,
					sample.file?.onDisk,
				]);
				if (signature === previousDb) continue;
				previousDb = signature;
				console.log(
					`t+${sample.at - turnStart} | ${clock(sample.at)} | status=${
						sample.job?.status ?? "—"
					} phase=${sample.job?.phase ?? "—"} phase_at=${
						sample.job?.phaseAt === null || sample.job?.phaseAt === undefined
							? "—"
							: `t+${sample.job.phaseAt - turnStart} (${clock(sample.job.phaseAt)})`
					} held_until=${
						sample.job?.heldUntil === null ||
						sample.job?.heldUntil === undefined
							? "—"
							: `set, ${Math.round((sample.job.heldUntil - sample.at) / 1000)}s left`
					} result_file=${
						sample.job?.resultFileId ?? "—"
					} picked_take=${sample.card?.pickedTakeId ?? "—"} file_on_disk=${
						sample.file?.onDisk ?? "—"
					}`,
				);
			}

			console.log("\n=== fake ComfyUI transitions ===");
			let previousFake = "";
			for (const sample of fakeSamples) {
				const signature = `${sample.submitted}|${sample.promptStatus}`;
				if (signature === previousFake) continue;
				previousFake = signature;
				console.log(
					`t+${sample.at - turnStart} | prompts submitted=${sample.submitted} status=${sample.promptStatus ?? "—"}`,
				);
			}

			if (job) {
				console.log(
					`last read: created_at ${job.createdAt}, started_at ${job.startedAt}, completed_at ${job.completedAt}, result_file_id ${job.resultFileId}, held_until ${job.heldUntil}, status ${job.status}, phase ${job.phase}`,
				);
			}
			console.log(
				`fake finished t+${fakeDoneAt === null ? "?" : fakeDoneAt - turnStart}; tool done t+${
					toolDoneAt === null ? "?" : toolDoneAt - turnStart
				}; card t+${cardAt === null ? "?" : cardAt - turnStart}; ready t+${
					readyAt === null ? "?" : readyAt - turnStart
				}; img t+${imgAt === null ? "?" : imgAt - turnStart}; reply persisted t+${
					at("SERVER: assistant reply persisted (messages row)") === null
						? "?"
						: (
								at("SERVER: assistant reply persisted (messages row)") as number
							) - turnStart
				}; reply action row t+${
					at("STREAM: assistant reply finished (action row appears)") === null
						? "not seen"
						: (
								at(
									"STREAM: assistant reply finished (action row appears)",
								) as number
							) - turnStart
				}`,
			);
			const lastDom = domSamples[domSamples.length - 1];
			if (lastDom) {
				console.log(
					`last sample: card=${lastDom.card} state=${lastDom.state ?? "—"} picture=${lastDom.picture} imgLoaded=${lastDom.imgLoaded} naturalWidth=${lastDom.naturalWidth} tool=${lastDom.toolStatus ?? "—"} finalText=${lastDom.finalText} replyEnded=${lastDom.replyEnded} (sampled t+${lastDom.at - turnStart})`,
				);
			}

			expect(
				cardAt,
				"the card element appeared during the probe",
			).not.toBeNull();
			expect(
				readyAt,
				"the card showed a real take during the probe",
			).not.toBeNull();
			expect(imgAt, "the picture loaded during the probe").not.toBeNull();
		} finally {
			if (conversationId) {
				await page.request
					.delete(`/api/conversations/${conversationId}`)
					.catch(() => undefined);
			}
			if (model && page.url() !== "about:blank") {
				await releaseSpecChatModel(page, model).catch(() => undefined);
			}
			if (fake) await stopFakeComfyUiForSpec(page, fake).catch(() => undefined);
			await fakeProvider.stop().catch(() => undefined);
		}
	});
}

// A page that hydrates under the throttle would measure the whole app's
// assets, not the picture: the page loads at full speed and the throttle goes
// on before the turn. Everything after it - the detail reads, the stream and
// the picture - sees the slow network, as a phone would.
test.describe("download bytes", () => {
	test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
	test.skip(!BYTES, "set IMAGE_TIMING_BYTES=1");

	test("which picture the card downloads, how many bytes, and how long to decoded", async ({
		page,
	}) => {
		test.setTimeout(300_000);
		const fakeProvider = createOpenAICompatibleProviderHarness();
		let fake: FakeComfyUi | null = null;
		let model: Awaited<ReturnType<typeof useSpecChatModel>> | null = null;
		let conversationId: string | null = null;
		const cdp = await page.context().newCDPSession(page);
		try {
			await fakeProvider.start();
			await fakeProvider.reset();
			await login(page);
			model = await useSpecChatModel(
				page,
				fakeProvider.baseURL,
				"images_timing_bytes_",
			);
			fake = await startFakeComfyUiForSpec(page);
			// 2048 x 2048 PNG, a few MB: the picture a real production take is.
			fake.setOptions({
				steps: 4,
				stepDelayMs: 250,
				render: () => largePng(2048),
			});
			conversationId = await createEmptyConversation(page);
			await page.goto(`/chat/${conversationId}`, {
				waitUntil: "domcontentloaded",
			});
			await waitForHydration(page);
			await expect(page.getByTestId("message-input")).toBeEnabled();

			const throttle = { latencyMs: 400, bytesPerSecond: 51_200 };
			type Transfer = {
				url: string;
				variant: string;
				startedAt: number;
				respondedAt: number | null;
				finishedAt: number | null;
				status: number | null;
				contentType: string | null;
				encodedBytes: number | null;
			};
			const transfers = new Map<string, Transfer>();
			const isPicture = (url: string) => url.includes("/api/images/files/");
			const variantOf = (url: string) =>
				new URL(url).searchParams.get("variant") ?? "full";
			cdp.on("Network.requestWillBeSent", (event) => {
				if (!isPicture(event.request.url)) return;
				transfers.set(event.requestId, {
					url: event.request.url,
					variant: variantOf(event.request.url),
					startedAt: Date.now(),
					respondedAt: null,
					finishedAt: null,
					status: null,
					contentType: null,
					encodedBytes: null,
				});
			});
			cdp.on("Network.responseReceived", (event) => {
				const row = transfers.get(event.requestId);
				if (!row) return;
				row.respondedAt = Date.now();
				row.status = event.response.status;
				row.contentType = event.response.headers["content-type"] ?? null;
			});
			cdp.on("Network.loadingFinished", (event) => {
				const row = transfers.get(event.requestId);
				if (!row) return;
				row.finishedAt = Date.now();
				row.encodedBytes = event.encodedDataLength;
			});
			await cdp.send("Network.enable");
			await cdp.send("Network.emulateNetworkConditions", {
				offline: false,
				latency: throttle.latencyMs,
				downloadThroughput: throttle.bytesPerSecond,
				uploadThroughput: throttle.bytesPerSecond,
			});

			type ByteSample = {
				at: number;
				card: boolean;
				state: string | null;
				imgLoaded: boolean;
				naturalWidth: number;
				currentSrc: string;
				jobStatus: string | null;
			};
			const sample = () =>
				page.evaluate(
					({ cardSelector }) => {
						const card = document.querySelector(cardSelector);
						const body = card?.querySelector('[data-testid="image-card-body"]');
						const img = card?.querySelector(
							'img[data-testid="image-picture-after"]',
						) as HTMLImageElement | null;
						return {
							at: Date.now(),
							card: card !== null,
							state: body?.getAttribute("data-state") ?? null,
							imgLoaded: img?.classList.contains("is-loaded") ?? false,
							naturalWidth: img?.naturalWidth ?? 0,
							currentSrc: img?.currentSrc ?? "",
						};
					},
					{ cardSelector: CARD },
				);
			const jobStatus = async (id: string): Promise<string | null> => {
				const [row] = await db
					.select({ status: imageJobs.status })
					.from(imageJobs)
					.where(eq(imageJobs.conversationId, id))
					.orderBy(asc(imageJobs.createdAt))
					.limit(1);
				return row?.status ?? null;
			};

			const samples: ByteSample[] = [];
			const turnStart = Date.now();
			let stop = false;
			let loopError: unknown = null;
			const poll = (async () => {
				while (!stop) {
					const tick = Date.now();
					try {
						const dom: ByteSample = {
							...(await sample()),
							jobStatus: await jobStatus(conversationId as string),
						};
						samples.push(dom);
					} catch (error) {
						if (!stop) loopError = error;
						break;
					}
					const loaded = samples.find(
						(entry) => entry.imgLoaded && entry.naturalWidth > 0,
					);
					if (loaded && Date.now() - loaded.at >= 2_000) break;
					if (Date.now() - turnStart > 240_000) break;
					const elapsed = Date.now() - tick;
					await new Promise((resolve) =>
						setTimeout(resolve, Math.max(20, 100 - elapsed)),
					);
				}
			})();

			try {
				await sendMessage(page, AI_SMOKE_MAKE_IMAGE_MARKER);
				await poll;
			} finally {
				stop = true;
				await poll.catch(() => undefined);
			}
			if (loopError) throw loopError;

			const first = (predicate: (entry: ByteSample) => boolean) =>
				samples.find(predicate)?.at ?? null;
			const cardAt = first((entry) => entry.card);
			const readyAt = first((entry) => entry.state === "ready");
			const settledAt = first((entry) => entry.jobStatus === "succeeded");
			const decodedAt = first(
				(entry) => entry.imgLoaded && entry.naturalWidth > 0,
			);
			const finalSrc =
				[...samples].reverse().find((entry) => entry.currentSrc)?.currentSrc ??
				"";
			const rows = [...transfers.values()].sort(
				(a, b) => a.startedAt - b.startedAt,
			);
			const t = (at: number | null) =>
				at === null ? "—" : `t+${at - turnStart}`;

			console.log(
				"\n=== picture download: 2048 px fake, DPR 2, 1280 x 900 ===",
			);
			console.log(
				`throttle ${throttle.latencyMs} ms latency, ${throttle.bytesPerSecond} B/s down/up; conversation ${conversationId}`,
			);
			console.log(
				"image request | variant | status | content-type | bytes | started | finished",
			);
			for (const row of rows) {
				console.log(
					`${row.url} | ${row.variant} | ${row.status ?? "—"} | ${
						row.contentType ?? "—"
					} | ${row.encodedBytes ?? "—"} | ${t(row.startedAt)} | ${t(
						row.finishedAt,
					)}`,
				);
			}
			if (rows.length === 0) console.log("none");
			console.log(
				`card element ${t(cardAt)}; card ready ${t(readyAt)}; take settled ${t(
					settledAt,
				)}; <img> decoded ${t(decodedAt)}; settle -> decoded ${
					settledAt !== null && decodedAt !== null
						? `${decodedAt - settledAt} ms`
						: "not measured"
				}`,
			);
			console.log(`currentSrc: ${finalSrc || "—"}`);

			expect(
				cardAt,
				"the card element appeared during the probe",
			).not.toBeNull();
			expect(decodedAt, "the picture decoded during the probe").not.toBeNull();
			expect(rows.length, "the card requested a picture file").toBeGreaterThan(
				0,
			);
		} finally {
			if (conversationId) {
				await page.request
					.delete(`/api/conversations/${conversationId}`)
					.catch(() => undefined);
			}
			if (model && page.url() !== "about:blank") {
				await releaseSpecChatModel(page, model).catch(() => undefined);
			}
			if (fake) await stopFakeComfyUiForSpec(page, fake).catch(() => undefined);
			await fakeProvider.stop().catch(() => undefined);
		}
	});
});
