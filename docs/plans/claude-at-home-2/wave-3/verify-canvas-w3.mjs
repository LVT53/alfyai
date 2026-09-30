// verify-canvas-w3.mjs — live check of the Canvas (Feature 2, Wave 3) against a deployed AlfyAI.
//
// ONE self-contained ES module (Node built-ins only), so it can be piped in without leaving a file on the box:
//
//   ssh -T alfyroot 'set -a; . /root/verify-harness.env; set +a; BASE=http://127.0.0.1:3002 \
//     node --input-type=module -' < verify-canvas-w3.mjs
//
// Env (the same as the Wave 2 live check): EMAIL, PASSWORD, BASE (default http://127.0.0.1:3002),
//   ONLY  (comma list of scenario ids or parts of them: create-en, edit, create-hu, incognito, alfy-comment; "sizes" is opt-in),
//   TURN_TIMEOUT_MS (one chat turn or one @Alfy reply; default 300000).
//   KEEP=0 deletes the conversations it made when it is done (default: they stay, so the boards can be looked at).
//
// It really talks to the model: it logs in like the browser, makes conversations, sends turns through
// POST /api/chat/stream (the stream is drained), and reads what the app stored through the same routes the panel uses.
// Every scenario prints PASS or FAIL with its evidence; the exit code is 1 when any FAIL.
//
// Scenarios (each edit item is one the first board cannot already hold — the Wave 2 lesson):
//   create-en    An English request makes a Canvas with >= 3 notes-or-blocks and a frame, and every block that has a
//                frame is drawn inside it by the sizes the board stores (the model's own frame size, its own block
//                width, and the height the panel draws a block at — the same estimate the app tells the model).
//   edit         "Add a frame called Rainy day with two notes" lands as ONE new Alfy version, with no refused op,
//                and the board then holds that frame with those two notes inside it.
//   create-hu    A Hungarian request gives Hungarian labels (frames, notes, checklist, title).
//   incognito    An incognito conversation's board is readable only through that conversation: not by a bare id, not
//                through another conversation, not in its list, not in the Knowledge library, not in Workspace Search.
//   alfy-comment An @Alfy comment on a note gets a reply AND a change (one new Alfy version, the note changed).
//   sizes        OPT-IN (only when ONLY names it; RC-3 found it failing before the deploy): a chart Alfy adds is stored at
//                least as large as the chart block's own minimum (240x160), so the panel does not draw it as a sliver, and a
//                checklist with long items is at least as wide as the one the Insert menu makes (260), so the items are not cut off.
import { randomUUID } from "node:crypto";

const BASE = (process.env.BASE ?? "http://127.0.0.1:3002").replace(/\/+$/, "");
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const ONLY = (process.env.ONLY ?? "")
	.split(",")
	.map((part) => part.trim().toLowerCase())
	.filter(Boolean);
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 300_000);
const KEEP = process.env.KEEP !== "0";

// ── the panel's own geometry (a copy of src/lib/shared/artifacts/canvas-blocks.ts) ──────────────
const NODE_WIDTH = 190;
const DEFAULT_NODE_HEIGHT = 84;
const NOTE_MIN_HEIGHT = 64;
const NOTE_LINE_HEIGHT = 18;
const NOTE_PADDING_HEIGHT = 18;
const TEXT_MIN_HEIGHT = 32;
const TEXT_PADDING_HEIGHT = 14;
const NOTE_SIDE_PADDING = 20;
const NOTE_CHAR_WIDTH = 9.4;
const CHECKLIST_BASE_HEIGHT = 74;
const CHECKLIST_ROW_HEIGHT = 26;
const charsPerLine = (width) =>
	Math.max(1, Math.floor((width - NOTE_SIDE_PADDING) / NOTE_CHAR_WIDTH));
const wrappedLines = (text, width) =>
	String(text ?? "")
		.split("\n")
		.reduce(
			(lines, line) =>
				lines +
				Math.max(1, Math.ceil(Array.from(line).length / charsPerLine(width))),
			0,
		);
function heightOf(node) {
	if (typeof node.height === "number") return node.height;
	const data = node.data ?? {};
	const width = typeof node.width === "number" ? node.width : NODE_WIDTH;
	switch (data.kind) {
		case "frame":
			return data.height;
		case "sticky":
			return Math.max(
				NOTE_MIN_HEIGHT,
				NOTE_PADDING_HEIGHT + NOTE_LINE_HEIGHT * wrappedLines(data.text, width),
			);
		case "text":
			return Math.max(
				TEXT_MIN_HEIGHT,
				TEXT_PADDING_HEIGHT + NOTE_LINE_HEIGHT * wrappedLines(data.text, width),
			);
		case "checklist":
			return CHECKLIST_BASE_HEIGHT + CHECKLIST_ROW_HEIGHT * (data.items?.length ?? 0);
		default:
			return DEFAULT_NODE_HEIGHT;
	}
}
const widthOf = (node) =>
	node.data?.kind === "frame"
		? (node.width ?? node.data.width)
		: typeof node.width === "number"
			? node.width
			: NODE_WIDTH;
const frameHeightOf = (frame) => frame.height ?? frame.data?.height;

/** Every child of a frame: does it sit inside the frame, by the stored sizes? Returns the problems, in words. */
function frameProblems(body) {
	const problems = [];
	const frames = new Map(body.nodes.filter((n) => n.type === "frame").map((n) => [n.id, n]));
	for (const node of body.nodes) {
		if (!node.parentId) continue;
		const frame = frames.get(node.parentId);
		if (!frame) {
			problems.push(`"${label(node)}" names a parent (${node.parentId}) that is not a frame`);
			continue;
		}
		const w = widthOf(node);
		const h = heightOf(node);
		const fw = widthOf(frame);
		const fh = frameHeightOf(frame);
		const { x, y } = node.position;
		if (x < 0 || y < 0 || x + w > fw || y + h > fh) {
			problems.push(
				`"${label(node)}" at (${x}, ${y}) ${w}x${h} sticks out of frame "${label(frame)}" (${fw}x${fh})`,
			);
		}
	}
	return problems;
}
/** Siblings that overlap each other (reported as information, not failed on). */
function overlaps(body) {
	const out = [];
	const byParent = new Map();
	for (const node of body.nodes) {
		if (node.type === "frame" && !node.parentId) continue;
		const key = node.parentId ?? "";
		byParent.set(key, [...(byParent.get(key) ?? []), node]);
	}
	for (const nodes of byParent.values()) {
		for (let i = 0; i < nodes.length; i += 1) {
			for (let j = i + 1; j < nodes.length; j += 1) {
				const a = nodes[i];
				const b = nodes[j];
				const ax2 = a.position.x + widthOf(a);
				const ay2 = a.position.y + heightOf(a);
				const bx2 = b.position.x + widthOf(b);
				const by2 = b.position.y + heightOf(b);
				if (a.position.x < bx2 && b.position.x < ax2 && a.position.y < by2 && b.position.y < ay2) {
					out.push(`"${label(a)}" and "${label(b)}"`);
				}
			}
		}
	}
	return out;
}
function label(node) {
	const d = node.data ?? {};
	return String(d.label ?? d.text ?? d.title ?? node.id).replace(/\s+/g, " ").slice(0, 40);
}
function textsOf(body, title) {
	const texts = [];
	if (title) texts.push({ where: "title", text: title });
	for (const node of body.nodes) {
		const d = node.data ?? {};
		if (d.kind === "frame" && d.label) texts.push({ where: "frame", text: d.label });
		if ((d.kind === "sticky" || d.kind === "text") && d.text) texts.push({ where: d.kind, text: d.text });
		if (d.kind === "checklist") {
			if (d.label) texts.push({ where: "checklist label", text: d.label });
			for (const item of d.items ?? []) texts.push({ where: "checklist item", text: item.text });
		}
	}
	return texts;
}

// ── language (a smoke test, not a classifier) ─────────────────────────────────────────────────────
const HU_CHARS = /[áéíóöőúüű]/i;
const HU_WORDS =
	/\b(szombat|vasárnap|reggel|reggeli|ebéd|vacsora|múzeum|séta|kávé|program|terv|csomagolás|útlevél|töltő|hétvége|hétvégi|kirándulás|bécs|délután|este|lista|és|egy|az|nap|jegy|foglalás|indulás|érkezés|városnézés|szálloda|fürdő|piac|sütemény|kastély)\b/i;
const EN_FUNCTION = /\b(the|and|with|for|of|to|at|in|on)\b/gi;
function looksHungarian(text) {
	const english = (String(text).match(EN_FUNCTION) ?? []).length;
	return (HU_CHARS.test(text) || HU_WORDS.test(text)) && english < 2;
}

// ── the wire ──────────────────────────────────────────────────────────────────────────────────────
let cookie = "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const made = { conversations: [] };

function cookieFrom(res) {
	const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
	const raw = list.length > 0 ? list : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[\w-]+=)/);
	return raw
		.map((c) => c.split(";")[0].trim())
		.filter(Boolean)
		.join("; ");
}
async function api(path, { method = "GET", body, timeoutMs = 60_000, headers = {} } = {}) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: {
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(cookie ? { cookie } : {}),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: res.status, json, text };
}
async function login() {
	if (!EMAIL || !PASSWORD) throw new Error("EMAIL and PASSWORD must be set (the box's /root/verify-harness.env)");
	const res = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
	cookie = cookieFrom(res);
	if (!cookie) throw new Error("login gave no session cookie");
}
async function newConversation(title, { incognito = false } = {}) {
	const res = await api("/api/conversations", {
		method: "POST",
		body: { title, ...(incognito ? { memoryIncognito: true } : {}) },
	});
	if (res.status !== 201 || !res.json?.id) throw new Error(`could not create a conversation: HTTP ${res.status} ${res.text.slice(0, 160)}`);
	made.conversations.push(res.json.id);
	return res.json.id;
}
/** One chat turn through the real stream route; drains it. Returns what the stream said. */
async function sendTurn(conversationId, message) {
	const started = Date.now();
	const res = await fetch(`${BASE}/api/chat/stream`, {
		method: "POST",
		headers: { "Content-Type": "application/json", cookie },
		body: JSON.stringify({ message, conversationId, streamId: randomUUID() }),
		signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
	});
	if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, ms: Date.now() - started, tools: [] };
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let raw = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			raw += decoder.decode(value, { stream: true });
			if (raw.includes("[DONE]")) break;
		}
		await reader.cancel().catch(() => undefined);
	} catch (error) {
		return { ok: false, error: `stream: ${error?.name ?? error}`, ms: Date.now() - started, tools: [] };
	}
	const parts = parseFrames(raw);
	// The app's own tool-call events (`data-tool-call`): one record per call, the last state of each.
	const byCall = new Map();
	for (const part of parts) {
		if (part.type === "data-tool-call" && part.data?.name) byCall.set(part.data.callId ?? `${part.data.name}#${byCall.size}`, part.data);
	}
	const toolCalls = [...byCall.values()];
	const errorPart = parts.find((part) => part.type === "error" || part.type === "data-stream-error");
	const error = errorPart ? String(errorPart.errorText ?? errorPart.data?.message ?? errorPart.error ?? "stream error").slice(0, 200) : undefined;
	return { ok: !error, error, ms: Date.now() - started, tools: [...new Set(toolCalls.map((call) => call.name))], toolCalls };
}
/** The `data: {...}` frames of an AI SDK UI stream, parsed; anything that is not JSON is skipped. */
function parseFrames(raw) {
	const parts = [];
	for (const block of raw.split(/\r?\n\r?\n/)) {
		for (const line of block.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (!payload || payload === "[DONE]") continue;
			try {
				parts.push(JSON.parse(payload));
			} catch {}
		}
	}
	return parts;
}
async function waitFor(fn, { timeoutMs = 45_000, everyMs = 1_500 } = {}) {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() > until) return null;
		await sleep(everyMs);
	}
}
async function boardsOf(conversationId) {
	const res = await api(`/api/artifacts?conversationId=${encodeURIComponent(conversationId)}`);
	return (res.json?.artifacts ?? []).filter((a) => a.kind === "canvas");
}
async function readBoard(id, conversationId) {
	const res = await api(`/api/artifacts/${encodeURIComponent(id)}${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`);
	if (!res.json?.ok) return { status: res.status };
	let body = null;
	try {
		body = JSON.parse(res.json.artifact.body ?? "null");
	} catch {}
	return { status: res.status, title: res.json.artifact.title, version: res.json.artifact.versionNumber, body, versions: res.json.versions ?? [], comments: res.json.comments ?? [] };
}
async function lastAssistantToolCalls(conversationId) {
	const res = await api(`/api/conversations/${encodeURIComponent(conversationId)}`);
	const messages = res.json?.messages ?? [];
	const assistants = messages.filter((m) => m.role === "assistant");
	const last = assistants.at(-1);
	return (last?.thinkingSegments ?? []).filter((s) => s?.type === "tool_call");
}

// ── reporting ────────────────────────────────────────────────────────────────────────────────────
const results = [];
function report(id, pass, evidence) {
	results.push({ id, pass });
	console.log(`${pass ? "PASS" : "FAIL"} ${id} — ${evidence}`);
}
const OPT_IN = new Set(["sizes"]);
const wanted = (id) => (OPT_IN.has(id) ? ONLY.some((part) => id.includes(part)) : ONLY.length === 0 || ONLY.some((part) => id.includes(part)));

// ── scenarios ────────────────────────────────────────────────────────────────────────────────────
const ctx = { enConversation: null, enBoard: null };

const EN_REQUEST =
	'Make me a Canvas board for a weekend in Vienna. Put a frame called "Saturday" and a frame called "Sunday" on it, each holding two or three short notes with the plan and a time, and add a packing checklist outside the frames.';

async function makeEnglishBoard() {
	const conversationId = await newConversation("Canvas live check: English");
	const turn = await sendTurn(conversationId, EN_REQUEST);
	const boards = await waitFor(async () => {
		const list = await boardsOf(conversationId);
		return list.length > 0 ? list : null;
	});
	ctx.enConversation = conversationId;
	return { conversationId, turn, boards: boards ?? [] };
}
async function ensureBoard() {
	if (ctx.enBoard) return ctx.enBoard;
	const { conversationId, boards } = await makeEnglishBoard();
	if (boards.length === 0) return null;
	ctx.enBoard = { conversationId, id: boards[0].id };
	return ctx.enBoard;
}

async function scenarioCreateEnglish() {
	const id = "create-en";
	const { conversationId, turn, boards } = await makeEnglishBoard();
	if (boards.length === 0) {
		report(id, false, `no Canvas in the chat after the turn (ok=${turn.ok}, tools=${turn.tools.join(",") || "none"}, ${turn.ms} ms${turn.error ? `, ${turn.error}` : ""})`);
		return;
	}
	const card = boards[0];
	ctx.enBoard = { conversationId, id: card.id };
	const board = await readBoard(card.id, conversationId);
	const nodes = board.body?.nodes ?? [];
	const frames = nodes.filter((n) => n.type === "frame");
	const blocks = nodes.filter((n) => n.type !== "frame");
	const inFrames = blocks.filter((n) => n.parentId).length;
	const problems = board.body ? frameProblems(board.body) : ["the stored board could not be read"];
	const overlap = board.body ? overlaps(board.body) : [];
	const pass = frames.length >= 1 && blocks.length >= 3 && inFrames >= 1 && problems.length === 0;
	report(
		id,
		pass,
		`"${board.title}" v${board.version}: ${frames.length} frame(s), ${blocks.length} block(s) (${inFrames} inside a frame); ` +
			(problems.length ? `OUTSIDE THE FRAME: ${problems.slice(0, 3).join("; ")}` : "every block with a frame is inside it by the stored sizes") +
			`; overlaps among siblings: ${overlap.length ? overlap.slice(0, 3).join("; ") : "none"}; tools=${turn.tools.join(",")}; ${turn.ms} ms`,
	);
}

async function scenarioEdit() {
	const id = "edit";
	const target = await ensureBoard();
	if (!target) return report(id, false, "no board to edit (the English board could not be made)");
	const before = await readBoard(target.id, target.conversationId);
	const beforeFrames = (before.body?.nodes ?? []).filter((n) => n.type === "frame").map((n) => label(n));
	const request =
		'On that Canvas, add a new frame called "Rainy day" with two notes inside it: "Kunsthistorisches Museum, 10:00" and "Café Central, 14:00".';
	const turn = await sendTurn(target.conversationId, request);
	const after = await waitFor(async () => {
		const current = await readBoard(target.id, target.conversationId);
		return current.version > before.version ? current : null;
	}, { timeoutMs: 30_000 });
	if (!after) return report(id, false, `the board did not change (v${before.version}; ok=${turn.ok}, tools=${turn.tools.join(",") || "none"}${turn.error ? `, ${turn.error}` : ""}; frames before: ${beforeFrames.join(", ")})`);
	const newVersions = after.versions.filter((v) => v.versionNumber > before.version);
	const alfyVersions = newVersions.filter((v) => v.author === "alfy");
	// What the turn's own stream said about its edits; the persisted message is the fallback.
	const streamed = turn.toolCalls.filter((c) => c.name === "edit_artifact" && c.status !== "running");
	const calls = streamed.length > 0 ? streamed : (await lastAssistantToolCalls(target.conversationId)).filter((c) => c.name === "edit_artifact");
	const refusals = calls
		.map((c) => c.metadata?.refusedBlocksJson ?? (/refused/i.test(c.outputSummary ?? "") ? c.outputSummary : null))
		.filter(Boolean);
	const nodes = after.body?.nodes ?? [];
	const frame = nodes.find((n) => n.type === "frame" && /rainy/i.test(label(n)));
	const kids = frame ? nodes.filter((n) => n.parentId === frame.id) : [];
	const hasMuseum = kids.some((n) => /kunsthistor/i.test(label(n)));
	const hasCafe = kids.some((n) => /caf[eé] central/i.test(label(n)));
	const problems = after.body ? frameProblems(after.body) : [];
	const pass = newVersions.length === 1 && alfyVersions.length === 1 && refusals.length === 0 && !!frame && hasMuseum && hasCafe;
	report(
		id,
		pass,
		`v${before.version} -> v${after.version}: ${newVersions.length} new version(s) (${alfyVersions.length} by Alfy: ${JSON.stringify(newVersions.map((v) => `${v.author}:${v.summary}`))}); ` +
			`edit_artifact calls=${calls.length}, refusals=${refusals.length ? JSON.stringify(refusals) : "none"}; frame "Rainy day": ${frame ? "yes" : "NO"}, its notes: museum=${hasMuseum} cafe=${hasCafe}; ` +
			`frame problems: ${problems.length ? problems.slice(0, 2).join("; ") : "none"}; ${turn.ms} ms`,
	);
}

async function scenarioCreateHungarian() {
	const id = "create-hu";
	const conversationId = await newConversation("Canvas live check: magyar");
	const turn = await sendTurn(
		conversationId,
		"Készíts egy táblát a hétvégi bécsi kirándulásomhoz: két keret (Szombat és Vasárnap), mindegyikben két-három rövid jegyzet a tervvel és az idővel, meg egy csomagolási lista a keretek mellett.",
	);
	const boards = await waitFor(async () => {
		const list = await boardsOf(conversationId);
		return list.length > 0 ? list : null;
	});
	if (!boards) return report(id, false, `no Canvas after the Hungarian request (ok=${turn.ok}, tools=${turn.tools.join(",") || "none"}${turn.error ? `, ${turn.error}` : ""})`);
	const board = await readBoard(boards[0].id, conversationId);
	const texts = textsOf(board.body ?? { nodes: [] }, board.title);
	const hu = texts.filter((t) => looksHungarian(t.text));
	const frames = texts.filter((t) => t.where === "frame");
	const framesHu = frames.length > 0 && frames.every((t) => looksHungarian(t.text));
	const share = texts.length ? hu.length / texts.length : 0;
	const english = texts.filter((t) => !looksHungarian(t.text)).map((t) => `${t.where}: "${t.text.slice(0, 40)}"`);
	report(
		id,
		framesHu && share >= 0.8,
		`"${board.title}": ${hu.length}/${texts.length} texts read as Hungarian, frame labels ${frames.map((f) => `"${f.text}"`).join(", ") || "none"} (${framesHu ? "Hungarian" : "NOT all Hungarian"}); not Hungarian: ${english.slice(0, 4).join(" | ") || "none"}; ${turn.ms} ms`,
	);
}

async function scenarioIncognito() {
	const id = "incognito";
	const other = ctx.enConversation ?? (await newConversation("Canvas live check: other chat"));
	const conversationId = await newConversation("Canvas live check: incognito", { incognito: true });
	const turn = await sendTurn(
		conversationId,
		'Make a small Canvas board titled "Incognito probe" with one frame called "Private" and two short notes inside it.',
	);
	const boards = await waitFor(async () => {
		const list = await boardsOf(conversationId);
		return list.length > 0 ? list : null;
	});
	if (!boards) return report(id, false, `no Canvas in the incognito chat (ok=${turn.ok}, tools=${turn.tools.join(",") || "none"}${turn.error ? `, ${turn.error}` : ""})`);
	const { id: boardId, title } = boards[0];
	const evidence = [];
	let pass = true;
	const check = (name, ok, detail) => {
		evidence.push(`${name}: ${ok ? "ok" : "LEAK"} (${detail})`);
		if (!ok) pass = false;
	};
	const inside = await api(`/api/artifacts/${boardId}?conversationId=${encodeURIComponent(conversationId)}`);
	check("read through its own chat", inside.status === 200, `HTTP ${inside.status}`);
	const bare = await api(`/api/artifacts/${boardId}`);
	check("bare id", bare.status === 404, `HTTP ${bare.status}`);
	const viaOther = await api(`/api/artifacts/${boardId}?conversationId=${encodeURIComponent(other)}`);
	check("through another chat", viaOther.status === 404, `HTTP ${viaOther.status}`);
	const otherList = await api(`/api/artifacts?conversationId=${encodeURIComponent(other)}`);
	check("in another chat's list", !(otherList.json?.artifacts ?? []).some((a) => a.id === boardId), `${(otherList.json?.artifacts ?? []).length} item(s) there`);
	const library = await api("/api/knowledge");
	check("Knowledge library", !library.text.includes(boardId) && !library.text.includes("Incognito probe"), `HTTP ${library.status}, ${library.text.length} bytes`);
	const search = await api(`/api/workspace-search?q=${encodeURIComponent("Incognito probe")}`);
	const found = (search.json?.documents ?? []).some((d) => JSON.stringify(d).includes(boardId));
	check("Workspace Search", !found && !JSON.stringify(search.json?.conversations ?? []).includes(boardId), `HTTP ${search.status}, ${(search.json?.documents ?? []).length} document hit(s)`);
	report(id, pass, `board "${title}" made in the incognito chat (${turn.ms} ms); ${evidence.join("; ")}`);
}

async function scenarioAlfyComment() {
	const id = "alfy-comment";
	const target = await ensureBoard();
	if (!target) return report(id, false, "no board to comment on (the English board could not be made)");
	const before = await readBoard(target.id, target.conversationId);
	const note = (before.body?.nodes ?? []).find((n) => n.data?.kind === "sticky");
	if (!note) return report(id, false, "the board has no note to comment on");
	const oldText = note.data.text;
	const posted = await api(`/api/artifacts/${target.id}/comments?conversationId=${encodeURIComponent(target.conversationId)}`, {
		method: "POST",
		body: { anchor: { kind: "node", nodeId: note.id }, body: "@Alfy please add the words \"moved to Monday\" at the end of this note." },
	});
	const commentId = posted.json?.comment?.id;
	if (!commentId) return report(id, false, `the comment was not posted: HTTP ${posted.status} ${posted.text.slice(0, 160)}`);
	const started = Date.now();
	const reply = await api(`/api/artifacts/${target.id}/comments/${commentId}/alfy?conversationId=${encodeURIComponent(target.conversationId)}`, { method: "POST", timeoutMs: TURN_TIMEOUT_MS });
	const after = await readBoard(target.id, target.conversationId);
	const changed = (after.body?.nodes ?? []).find((n) => n.id === note.id);
	const newText = changed?.data?.text ?? null;
	const newVersions = after.versions.filter((v) => v.versionNumber > before.version);
	const thread = after.comments.filter((c) => c.id === commentId || c.parentId === commentId);
	const alfyReplies = thread.filter((c) => c.author === "alfy");
	const pass =
		reply.json?.ok === true &&
		reply.json.outcome === "applied" &&
		reply.json.applied >= 1 &&
		!!reply.json.reply &&
		alfyReplies.length >= 1 &&
		newVersions.length === 1 &&
		newVersions[0].author === "alfy" &&
		typeof newText === "string" &&
		newText !== oldText &&
		/monday/i.test(newText);
	report(
		id,
		pass,
		`HTTP ${reply.status} outcome=${reply.json?.outcome ?? "?"} applied=${reply.json?.applied ?? "?"} refused=${reply.json?.refused ?? "?"} in ${Date.now() - started} ms; ` +
			`reply: ${JSON.stringify(String(reply.json?.reply?.body ?? "").slice(0, 100))}; new versions: ${JSON.stringify(newVersions.map((v) => `${v.author}:${v.summary}`))}; ` +
			`note "${String(oldText).slice(0, 40)}" -> "${String(newText).slice(0, 60)}"`,
	);
}

async function scenarioSizes() {
	const id = "sizes";
	const target = await ensureBoard();
	if (!target) return report(id, false, "no board to add blocks to (the English board could not be made)");
	const before = await readBoard(target.id, target.conversationId);
	const known = new Set((before.body?.nodes ?? []).map((n) => n.id));
	const turn = await sendTurn(
		target.conversationId,
		'On that Canvas, add two blocks to the right of the frames: a bar chart block titled "Trip expenses" with three bars (Food 40, Transport 25, Hotel 120), and a checklist titled "Before we leave" with these items: "Passport and ID card", "Phone charger and power bank", "Raincoat and a folding umbrella".',
	);
	const after = await waitFor(async () => {
		const current = await readBoard(target.id, target.conversationId);
		return current.version > before.version ? current : null;
	}, { timeoutMs: 30_000 });
	if (!after) return report(id, false, `the board did not change (ok=${turn.ok}, tools=${turn.tools.join(",") || "none"}${turn.error ? `, ${turn.error}` : ""})`);
	const fresh = (after.body?.nodes ?? []).filter((n) => !known.has(n.id));
	const chart = fresh.find((n) => n.data?.kind === "chart");
	const list = fresh.find((n) => n.data?.kind === "checklist");
	const problems = [];
	if (!chart) problems.push("no new chart block");
	else {
		let parsed = null;
		try {
			parsed = JSON.parse(chart.data.code);
		} catch {}
		const w = widthOf(chart);
		const h = typeof chart.height === "number" ? chart.height : null;
		// BLOCK_META.chart: default 360x250, minimum 240x160. Below the minimum the plot is a sliver.
		if (!parsed) problems.push("the chart's code is not Chart.js JSON");
		if (w < 240 || (h !== null && h < 160)) problems.push(`chart stored ${w}x${h ?? "(height left to the panel)"}: below the block's own minimum 240x160, so it is drawn as a sliver (the panel plans a block with no height at ${heightOf(chart)})`);
	}
	if (!list) problems.push("no new checklist block");
	else {
		const longest = Math.max(0, ...(list.data.items ?? []).map((i) => String(i.text).length));
		const w = widthOf(list);
		// The checklist the Insert menu makes is 260 wide; its rows do not wrap, so a narrower one cuts long items off (about 16 characters at 190).
		if (longest > 16 && w < 260) problems.push(`checklist stored ${w} wide with an item of ${longest} characters: rows do not wrap, so it is cut off (the Insert menu's checklist is 260 wide)`);
	}
	report(
		id,
		problems.length === 0,
		`${chart ? `chart ${widthOf(chart)}x${chart.height ?? "?"}` : "no chart"}; ${list ? `checklist ${widthOf(list)} wide, ${list.data.items?.length ?? 0} item(s)` : "no checklist"}; ${problems.length ? problems.join("; ") : "both are as large as the ones a reader inserts"}`,
	);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────
const scenarios = [
	["create-en", scenarioCreateEnglish],
	["edit", scenarioEdit],
	["create-hu", scenarioCreateHungarian],
	["incognito", scenarioIncognito],
	["alfy-comment", scenarioAlfyComment],
	["sizes", scenarioSizes],
];

try {
	await login();
	console.log(`logged in to ${BASE} as ${EMAIL}; turn timeout ${TURN_TIMEOUT_MS} ms${ONLY.length ? `; only: ${ONLY.join(",")}` : ""}`);
	for (const [id, run] of scenarios) {
		if (!wanted(id)) continue;
		try {
			await run();
		} catch (error) {
			report(id, false, `threw: ${error?.stack?.split("\n")[0] ?? error}`);
		}
	}
} catch (error) {
	console.log(`FAIL setup — ${error?.message ?? error}`);
	results.push({ id: "setup", pass: false });
} finally {
	if (!KEEP) {
		for (const id of made.conversations) {
			await api(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => undefined);
		}
	} else if (made.conversations.length > 0) {
		console.log(`conversations made (kept; KEEP=0 deletes them): ${made.conversations.join(" ")}`);
	}
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed${failed.length ? `; FAILED: ${failed.map((r) => r.id).join(", ")}` : ""}`);
process.exit(failed.length > 0 ? 1 : 0);
