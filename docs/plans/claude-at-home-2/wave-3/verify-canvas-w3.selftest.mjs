// Offline self-test of verify-canvas-w3.mjs: a tiny fake AlfyAI (same routes, same JSON shapes as the real ones)
// so the script's own logic — its parsing and its PASS/FAIL judgement — is exercised without a model.
//   node verify-canvas-w3.selftest.mjs good          -> every scenario PASSes
//   node verify-canvas-w3.selftest.mjs outside|versions|refusal|english|leak|noreply -> the named scenario FAILs
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "good";
process.env.EMAIL = "t@example.test";
process.env.PASSWORD = "x";
process.env.BASE = "http://fake.local";
process.env.TURN_TIMEOUT_MS = "5000";

const conversations = new Map(); // id -> { incognito, boards: [], messages: [] }
const boards = new Map(); // id -> { id, conversationId, title, version, body, versions: [] }
const comments = [];

const note = (id, x, y, text, parentId) => ({ id, type: "sticky", position: { x, y }, width: 190, ...(parentId ? { parentId } : {}), data: { kind: "sticky", text, tone: "yellow" } });
const frame = (id, x, y, w, h, label) => ({ id, type: "frame", position: { x, y }, width: w, height: h, data: { kind: "frame", label, width: w, height: h } });
function englishBoard() {
	return {
		version: 1,
		nodes: [
			frame("sat", 40, 40, 300, 300, "Saturday"),
			note("n1", 20, 50, "Museum, 10:00", "sat"),
			note("n2", 20, 130, "Lunch at the market, 12:30", "sat"),
			note("n3", 20, mode === "outside" ? 265 : 210, "Concert, 19:00", "sat"),
			frame("sun", 400, 40, 300, 300, "Sunday"),
			note("n4", 20, 50, "Palace tour, 09:30", "sun"),
			note("n5", 20, 130, "Coffee, 11:00", "sun"),
			{ id: "pack", type: "checklist", position: { x: 40, y: 400 }, data: { kind: "checklist", label: "Packing", items: [{ id: "i1", text: "Passport", done: false }, { id: "i2", text: "Charger", done: false }] } },
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}
function hungarianBoard() {
	const english = mode === "english";
	return {
		version: 1,
		nodes: [
			frame("sz", 40, 40, 300, 300, english ? "Saturday" : "Szombat"),
			note("h1", 20, 50, english ? "Visit the museum at ten" : "Múzeum, 10:00", "sz"),
			note("h2", 20, 130, english ? "Lunch with the family" : "Ebéd a piacon, 12:30", "sz"),
			frame("va", 400, 40, 300, 300, english ? "Sunday" : "Vasárnap"),
			note("h3", 20, 50, english ? "Walk in the park and coffee" : "Séta a városban, 11:00", "va"),
			{ id: "cs", type: "checklist", position: { x: 40, y: 400 }, data: { kind: "checklist", label: english ? "Packing list" : "Csomagolás", items: [{ id: "i1", text: english ? "Passport" : "Útlevél", done: false }] } },
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}
function makeBoard(conversationId, title, body) {
	const id = randomUUID();
	const s = JSON.stringify(body);
	boards.set(id, { id, conversationId, title, version: 1, body: s, versions: [{ id: randomUUID(), versionNumber: 1, author: "alfy", summary: "Alfy made the board", createdAt: Date.now() }] });
	conversations.get(conversationId).boards.push(id);
	return id;
}
function bump(board, body, author, summary) {
	board.version += 1;
	board.body = JSON.stringify(body);
	board.versions.push({ id: randomUUID(), versionNumber: board.version, author, summary, createdAt: Date.now() });
}
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function fakeFetch(input, init = {}) {
	const url = new URL(typeof input === "string" ? input : input.url);
	const path = url.pathname;
	const method = init.method ?? "GET";
	const body = init.body ? JSON.parse(init.body) : null;
	const conversationParam = url.searchParams.get("conversationId");
	if (path === "/api/auth/login") return new Response("{}", { status: 200, headers: { "set-cookie": "session=abc; Path=/; HttpOnly" } });
	if (path === "/api/conversations" && method === "POST") {
		const id = randomUUID();
		conversations.set(id, { incognito: body?.memoryIncognito === true, boards: [], messages: [] });
		return json(201, { id, title: body?.title });
	}
	if (path === "/api/chat/stream") {
		const conv = conversations.get(body.conversationId);
		const text = body.message;
		const records = [];
		if (/bar chart block/i.test(text)) {
			const board = boards.get(conv.boards[0]);
			const nodes = JSON.parse(board.body);
			const small = mode === "smallchart";
			nodes.nodes.push({ id: "ch", type: "chart", position: { x: 760, y: 40 }, width: small ? 190 : 360, ...(small ? {} : { height: 250 }), data: { kind: "chart", label: "Trip expenses", code: JSON.stringify({ type: "bar", data: { labels: ["Food", "Transport", "Hotel"], datasets: [{ data: [40, 25, 120] }] } }) } });
			nodes.nodes.push({ id: "cl", type: "checklist", position: { x: 760, y: 320 }, width: small ? 190 : 260, data: { kind: "checklist", label: "Before we leave", items: [{ id: "a", text: "Passport and ID card", done: false }, { id: "b", text: "Phone charger and power bank", done: false }, { id: "c", text: "Raincoat and a folding umbrella", done: false }] } });
			bump(board, nodes, "alfy", "Added the expenses chart and a checklist");
			records.push({ callId: "e9", name: "edit_artifact", status: "done", outputSummary: 'Edited canvas "x" (2 applied)', metadata: { ok: true, appliedCount: 2 } });
		} else if (/rainy day/i.test(text)) {
			const board = boards.get(conv.boards[0]);
			const nodes = JSON.parse(board.body);
			nodes.nodes.push(frame("rain", 400, 400, 300, 240, "Rainy day"), note("r1", 20, 50, "Kunsthistorisches Museum, 10:00", "rain"), note("r2", 20, 130, "Café Central, 14:00", "rain"));
			bump(board, nodes, "alfy", "Added the Rainy day frame");
			if (mode === "versions") bump(board, nodes, "alfy", "A second edit");
			const record = { type: "tool_call", callId: "e1", name: "edit_artifact", status: "done", outputSummary: mode === "refusal" ? 'Edited canvas "x" (2 applied, 1 refused)' : 'Edited canvas "x" (3 applied)', metadata: { ok: true, appliedCount: 3, ...(mode === "refusal" ? { refusedBlocksJson: JSON.stringify([{ blockId: "r2", reason: "invalid_data" }]) } : {}) } };
			records.push(record);
			conv.messages.push({ role: "assistant", thinkingSegments: [record] });
		} else if (/Készíts egy táblát/.test(text)) {
			makeBoard(body.conversationId, "Hétvégi bécsi kirándulás", hungarianBoard());
			records.push({ callId: "c1", name: "create_artifact", status: "done" });
		} else if (/Incognito probe/.test(text)) {
			makeBoard(body.conversationId, "Incognito probe", englishBoard());
			records.push({ callId: "c1", name: "create_artifact", status: "done" });
		} else {
			makeBoard(body.conversationId, "Vienna weekend", englishBoard());
			records.push({ callId: "c1", name: "create_artifact", status: "running" }, { callId: "c1", name: "create_artifact", status: "done" });
		}
		const frames = records.map((record) => `data: ${JSON.stringify({ type: "data-tool-call", data: record, transient: true })}\n\n`).join("");
		return new Response(`data: {"type":"text-start","id":"t"}\n\n${frames}data: {"type":"finish"}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	if (path === "/api/artifacts" && method === "GET") {
		const conv = conversations.get(conversationParam);
		if (!conv) return json(404, { ok: false, reason: "not_found" });
		return json(200, { ok: true, artifacts: conv.boards.map((id) => ({ id, kind: "canvas", title: boards.get(id).title, versionNumber: boards.get(id).version })) });
	}
	let m = /^\/api\/artifacts\/([^/]+)$/.exec(path);
	if (m && method === "GET") {
		const board = boards.get(m[1]);
		if (!board) return json(404, { ok: false, reason: "not_found" });
		const conv = conversations.get(board.conversationId);
		const named = conversationParam;
		if (conv.incognito && named !== board.conversationId && mode !== "leak") return json(404, { ok: false, reason: "not_found" });
		if (!conv.incognito && named && named !== board.conversationId && false) return json(404, { ok: false });
		if (conv.incognito && named && named !== board.conversationId) return json(404, { ok: false, reason: "not_found" });
		return json(200, { ok: true, artifact: { id: board.id, kind: "canvas", title: board.title, body: board.body, versionNumber: board.version }, versions: board.versions, comments: comments.filter((c) => c.artifactId === board.id) });
	}
	m = /^\/api\/artifacts\/([^/]+)\/comments$/.exec(path);
	if (m && method === "POST") {
		const comment = { id: randomUUID(), artifactId: m[1], parentId: null, anchor: body.anchor, author: "user", body: body.body };
		comments.push(comment);
		return json(200, { ok: true, comment });
	}
	m = /^\/api\/artifacts\/([^/]+)\/comments\/([^/]+)\/alfy$/.exec(path);
	if (m && method === "POST") {
		const board = boards.get(m[1]);
		const parsed = JSON.parse(board.body);
		const root = comments.find((c) => c.id === m[2]);
		const target = parsed.nodes.find((n) => n.id === root.anchor.nodeId);
		if (mode !== "noreply") {
			target.data.text = `${target.data.text} — moved to Monday`;
			bump(board, parsed, "alfy", "Alfy's comment reply");
			const reply = { id: randomUUID(), artifactId: m[1], parentId: m[2], anchor: null, author: "alfy", body: "Done, moved it to Monday." };
			comments.push(reply);
			return json(200, { ok: true, outcome: "applied", applied: 1, refused: 0, version: board.version, reply });
		}
		return json(200, { ok: true, outcome: "answered", applied: 0, refused: 0, version: board.version, reply: { id: "r", author: "alfy", body: "I can't." } });
	}
	m = /^\/api\/conversations\/([^/]+)$/.exec(path);
	if (m && method === "GET") return json(200, { messages: conversations.get(m[1])?.messages ?? [] });
	if (path === "/api/knowledge") return json(200, { documents: mode === "leak" ? [{ name: "Incognito probe" }] : [], results: [], workflows: [] });
	if (path === "/api/workspace-search") return json(200, { query: url.searchParams.get("q"), conversations: [], documents: [] });
	return json(404, { error: `fake: no route ${method} ${path}` });
}

globalThis.fetch = fakeFetch;
let exitCode = null;
process.exit = (code) => {
	exitCode = code;
	throw new Error("__exit__");
};
const here = dirname(fileURLToPath(import.meta.url));
try {
	await import(pathToFileURL(join(here, "verify-canvas-w3.mjs")).href);
} catch (error) {
	if (error?.message !== "__exit__") throw error;
}
console.log(`[selftest ${mode}] exit code ${exitCode}`);
