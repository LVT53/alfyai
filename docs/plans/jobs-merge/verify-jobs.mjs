// Live check of the job engine on ai.dev (staging), run on the box:
//   set -a; . /root/verify-harness.env; set +a; BASE=http://127.0.0.1:3002 node --input-type=module - < verify-jobs.mjs
// Covers: extraction (inline .txt, a PDF through MinerU with its phases, Cancel then Retry, Re-extract),
// Atlas (Cancel while running, a run to completion whose report waits on file production).
// Prints PASS/FAIL lines and a summary; exits non-zero when anything failed.

const BASE = process.env.BASE ?? "http://127.0.0.1:3002";
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const ONLY = (process.env.ONLY ?? "extraction,atlas").split(",");
if (!EMAIL || !PASSWORD) throw new Error("EMAIL and PASSWORD are required");

const results = [];
function record(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

let cookie = "";
async function api(path, init = {}) {
	const headers = { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) };
	if (!(init.body instanceof FormData) && !headers["content-type"]) headers["content-type"] = "application/json";
	const res = await fetch(`${BASE}${path}`, { ...init, headers });
	const sc = res.headers.getSetCookie?.() ?? [];
	if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
	return res;
}
async function json(path, init) {
	const res = await api(path, init);
	const text = await res.text();
	let body = null;
	try { body = JSON.parse(text); } catch { body = text; }
	return { status: res.status, ok: res.ok, body };
}

function makePdf(lines) {
	const content = `BT /F1 18 Tf 72 720 Td 22 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, "")}) Tj T*`).join(" ")} ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

async function upload(name, bytes, type) {
	const fd = new FormData();
	fd.append("file", new Blob([bytes], { type }), name);
	const r = await json("/api/knowledge/upload", {
		method: "POST",
		body: fd,
		headers: { "x-alfyai-upload-name": encodeURIComponent(name), "x-alfyai-upload-size": String(bytes.length) },
	});
	const artifactId = r.body?.artifact?.id ?? r.body?.artifactId ?? r.body?.id ?? null;
	const extraction = r.body?.extraction ?? null;
	return { status: r.status, artifactId, extraction, raw: r.body };
}

async function extractionStatus(artifactId) {
	const r = await json(`/api/knowledge/extraction?artifactIds=${encodeURIComponent(artifactId)}`);
	const list = Array.isArray(r.body) ? r.body : (r.body?.jobs ?? r.body?.items ?? Object.values(r.body ?? {}));
	const flat = list.flat?.() ?? list;
	const job = flat.find((j) => j && (j.sourceArtifactId === artifactId || j.artifactId === artifactId)) ?? flat[0] ?? null;
	return job;
}

async function waitExtraction(artifactId, label, timeoutMs = 600_000) {
	const t0 = Date.now();
	const seen = [];
	for (;;) {
		const job = await extractionStatus(artifactId);
		const st = job?.status ?? "none";
		if (seen[seen.length - 1] !== st) { seen.push(st); console.log(`  ${stamp()} ${label}: ${st}`); }
		if (["succeeded", "failed", "canceled"].includes(st)) return { job, seen };
		if (Date.now() - t0 > timeoutMs) return { job, seen, timedOut: true };
		await sleep(2000);
	}
}

async function extractionChecks() {
	console.log(`\n== extraction (${stamp()})`);
	const tag = Date.now();

	const txt = Buffer.from(`Job engine live check ${tag}.\nThis plain text file should be read inline, inside its upload request.\n`);
	const t = await upload(`engine-check-${tag}.txt`, txt, "text/plain");
	record("a .txt upload settles inside its request", t.status < 300 && t.extraction?.status === "succeeded",
		`http ${t.status}, extraction ${t.extraction?.status ?? "?"}`);

	const pdf = makePdf([`Job engine live check ${tag}`, "A PDF read by MinerU through the engine.", "Line three."]);
	const p = await upload(`engine-check-${tag}.pdf`, pdf, "application/pdf");
	record("a PDF upload is accepted and queued", p.status < 300 && Boolean(p.artifactId), `http ${p.status}, extraction ${p.extraction?.status ?? "?"}`);
	if (p.artifactId) {
		const done = await waitExtraction(p.artifactId, "pdf");
		record("the PDF is read to succeeded", done.job?.status === "succeeded", `seen ${done.seen.join(" > ")}${done.timedOut ? " (timed out)" : ""}`);
		record("the browser still sees the old phase words, never 'running'", !done.seen.includes("running") && !done.seen.includes("cancelled"), done.seen.join(","));

		// GET offers only upgrades over the tier the text was read at; POST refuses anything else.
		const info = await json(`/api/knowledge/extraction/${p.artifactId}/reextract`);
		const tier = Array.isArray(info.body?.tiers) ? info.body.tiers[0] : undefined;
		console.log(`  re-extract menu: http ${info.status} ${JSON.stringify(info.body).slice(0, 160)}`);
		if (!tier) {
			console.log("  SKIP Re-extract: no higher tier is offered for this document");
		} else {
			const rr = await json(`/api/knowledge/extraction/${p.artifactId}/reextract`, { method: "POST", body: JSON.stringify({ tier }) });
			console.log(`  re-extract: http ${rr.status} ${JSON.stringify(rr.body).slice(0, 200)}`);
			if (rr.ok) {
				const again = await waitExtraction(p.artifactId, "re-extract");
				record(`Re-extract at ${tier} runs the document again to succeeded`, again.job?.status === "succeeded", again.seen.join(" > "));
			} else {
				record(`Re-extract at ${tier} is accepted`, false, `http ${rr.status}`);
			}
		}
	}

	const pdf2 = makePdf([`Cancel then retry ${tag}`, "This one is stopped and started again."]);
	const c = await upload(`engine-cancel-${tag}.pdf`, pdf2, "application/pdf");
	if (c.artifactId) {
		const cancel = await json(`/api/knowledge/extraction/${c.artifactId}/cancel`, { method: "POST", body: "{}" });
		const after = await extractionStatus(c.artifactId);
		const cancelled = after?.status === "canceled" || (cancel.status === 409 && after?.status === "succeeded");
		record("Cancel stops the job (the card says canceled)", cancelled, `http ${cancel.status}, now ${after?.status}`);
		if (after?.status === "canceled") {
			const retry = await json(`/api/knowledge/extraction/${c.artifactId}/retry`, { method: "POST", body: "{}" });
			record("Retry after Cancel is accepted", retry.ok, `http ${retry.status} ${JSON.stringify(retry.body).slice(0, 120)}`);
			const done = await waitExtraction(c.artifactId, "retry");
			record("the retried job is read to succeeded", done.job?.status === "succeeded", done.seen.join(" > "));
		}
	} else {
		record("the second PDF upload is accepted", false, `http ${c.status}`);
	}
}

async function newConversation(title) {
	const r = await json("/api/conversations", { method: "POST", body: JSON.stringify({ title }) });
	return r.body?.id ?? r.body?.conversation?.id ?? r.body?.conversationId;
}

async function startAtlas(cid, query, profile = "overview") {
	const r = await json("/api/chat/send", {
		method: "POST",
		body: JSON.stringify({ conversationId: cid, message: query, attachmentIds: [], linkedSources: [], atlasMode: true, atlasProfile: profile, atlasAction: "create", parentAtlasId: null, clientAtlasTurnId: `engine-check-${Date.now()}` }),
	});
	return { status: r.status, jobId: r.body?.atlasJob?.id ?? null, body: r.body };
}

async function atlasJob(cid, jobId) {
	const d = await json(`/api/conversations/${cid}`);
	return (d.body?.atlasJobs ?? []).find((j) => j.id === jobId) ?? null;
}

async function atlasChecks() {
	console.log(`\n== atlas (${stamp()})`);
	const cidA = await newConversation(`engine-check atlas cancel ${new Date().toISOString()}`);
	const a = await startAtlas(cidA, "Create an Atlas report on the history of the Dublin tram network, using current web evidence.");
	record("an Atlas job is created and linked", a.status < 300 && Boolean(a.jobId), `http ${a.status}`);
	if (a.jobId) {
		let job = null;
		for (let i = 0; i < 60; i++) {
			job = await atlasJob(cidA, a.jobId);
			if (job?.status === "running") break;
			await sleep(2000);
		}
		record("the Atlas job is claimed (running)", job?.status === "running", `status ${job?.status} stage ${job?.stage}`);
		const cancel = await json(`/api/atlas/jobs/${a.jobId}/cancel`, { method: "POST", body: "{}" });
		const after = await atlasJob(cidA, a.jobId);
		record("Cancel settles the running Atlas job at once", after?.status === "cancelled" && after?.stage === "cancelled", `http ${cancel.status}, status ${after?.status}, stage ${after?.stage}`);
		await sleep(30_000);
		const later = await atlasJob(cidA, a.jobId);
		record("the cancelled Atlas job stays cancelled", later?.status === "cancelled", `status ${later?.status}`);
	}

	const cidB = await newConversation(`engine-check atlas run ${new Date().toISOString()}`);
	const b = await startAtlas(cidB, "Create an Atlas report on how Ireland's electricity grid is decarbonising: generation mix, wind and solar, interconnectors and storage, using current web evidence.");
	record("a second Atlas job is created", b.status < 300 && Boolean(b.jobId), `http ${b.status}`);
	if (!b.jobId) return;
	const t0 = Date.now();
	let last = "";
	let job = null;
	while (Date.now() - t0 < 45 * 60_000) {
		job = await atlasJob(cidB, b.jobId);
		const line = `${job?.status} ${job?.stage} ${job?.progress?.percent ?? "?"}%`;
		if (line !== last) { console.log(`  ${stamp()} atlas: ${line}`); last = line; }
		if (["succeeded", "failed", "cancelled"].includes(job?.status)) break;
		await sleep(15_000);
	}
	record("the Atlas run completes", job?.status === "succeeded", `status ${job?.status} error ${JSON.stringify(job?.error ?? null)} after ${Math.round((Date.now() - t0) / 1000)} s`);
	const md = job?.outputs?.markdownChatGeneratedFileId;
	const html = job?.outputs?.htmlChatGeneratedFileId;
	record("the Atlas report has its files (file production ran for it)", Boolean(md || html), JSON.stringify(job?.outputs ?? null).slice(0, 200));
	if (md) {
		const f = await api(`/api/chat/files/${md}/download`, { headers: { "content-type": "text/plain" } });
		const text = await f.text();
		record("the report downloads", f.ok && text.length > 500, `http ${f.status}, ${text.length} chars`);
	}
}

const login = await json("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PASSWORD, rememberMe: false }) });
if (!login.ok) throw new Error(`login ${login.status}`);
if (ONLY.includes("extraction")) await extractionChecks();
if (ONLY.includes("atlas")) await atlasChecks();

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(" | ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
