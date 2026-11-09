/**
 * The 4.1 client against reality, twice over.
 *
 *  1. **Replay**: the captured answers are handed back through an injected
 *     `fetchImpl`, and the REQUESTS the client made are asserted field by field.
 *     This is where S5's never-send list is proven (no `page_range`, no
 *     `include_model_output`, no `client_file_id`, no nulls, only
 *     `output_formats: ["default"]`) and where S7 is proven (the key goes to the
 *     configured origin and nowhere else).
 *  2. **The fake 4.1 server**: real HTTP on an ephemeral port, with the
 *     behaviours the spike recorded: the hash cache, a restart that forgets
 *     every id and the cache, a cancel that keeps finished files, FastAPI's
 *     404 for a server that does not speak /v1/tasks.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import {
	getMineruStatusReport,
	type MineruProbeClientFactory,
	resetMineruCapabilitiesCacheForTests,
	setMineruProbeClientFactory,
} from "./capabilities";
import { MineruClient } from "./client";
import type { MineruConfig } from "./config";
import {
	isMineruForgottenIdError,
	MineruApiError,
	mapMineruError,
	mapMineruTaskFailure,
	mineruWaitingUpload,
} from "./errors";
import type { MineruCreateTaskResponse, MineruUploadLink } from "./schemas";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	type FakeMineruServerOptions,
	MINERU_4_0_12_ERRORS,
	MINERU_PROTOCOL_FIXTURE_ROOT,
	readMineruProtocolFixture,
} from "./testing/fake-server";

/** The origin the captured URLs name: a client configured for it is "same origin". */
const RECORDED_ORIGIN = "http://127.0.0.1:8012";

function testConfig(patch: Partial<MineruConfig> = {}): MineruConfig {
	return {
		baseUrl: RECORDED_ORIGIN,
		apiKey: "",
		defaultTier: "auto",
		ocrMode: "auto",
		jobTimeoutMs: 5000,
		pollMinMs: 1,
		pollMaxMs: 5,
		requestTimeoutMs: 2000,
		transferTimeoutMs: 4000,
		capabilitiesTtlMs: 0,
		bundleMaxBytes: 33554432,
		bundleUserQuotaBytes: 0,
		structureChunking: true,
		...patch,
	};
}

interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
	redirect: RequestRedirect | undefined;
}

function scriptedFetch(
	handler: (call: RecordedCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		let body: unknown;
		if (typeof init?.body === "string") {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		} else if (init?.body) {
			body = "<stream>";
		}
		const call: RecordedCall = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: Object.fromEntries(headers.entries()),
			body,
			redirect: init?.redirect,
		};
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

interface Recorded {
	request: { path: string; json?: unknown };
	response: {
		status: number;
		headers?: Record<string, string>;
		json?: unknown;
	};
	snapshot?: unknown;
}

/** A captured answer, replayed as a `Response`. */
function replay(name: string): Response {
	const recorded = readMineruProtocolFixture<Recorded>(name);
	const body = recorded.snapshot ?? recorded.response.json;
	return new Response(body === undefined ? null : JSON.stringify(body), {
		status: recorded.response?.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

function body(name: string): Record<string, unknown> {
	const recorded = readMineruProtocolFixture<Recorded>(name);
	return (recorded.snapshot ?? recorded.response.json) as Record<
		string,
		unknown
	>;
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const never = new AbortController().signal;

let tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mineru-contract-"));
	tempDirs.push(dir);
	return dir;
}

/** The upload link of a create receipt that is waiting for bytes. */
function uploadOf(receipt: MineruCreateTaskResponse): MineruUploadLink {
	const upload = receipt.files[0]?.upload;
	if (!upload) throw new Error("the receipt has no upload link");
	return upload;
}

/** A file of known bytes to upload. */
function sampleFile(content = "a,b\n1,2\n"): { path: string; bytes: number } {
	const path = join(tempDir(), "document.csv");
	writeFileSync(path, content);
	return { path, bytes: Buffer.byteLength(content) };
}

/** The client logs the host of a URL it refuses; the tests read it instead of printing it. */
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	warn.mockRestore();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

const DOCX = {
	fileName: "report.docx",
	bytes: 50722,
	sha256sum: "99b17c29720ed689fba92e692706bfa9aa5a82ef4ed1aea5b04d5269b2318885",
};

// ---------------------------------------------------------------------------
// 1. Replaying the captured sequences
// ---------------------------------------------------------------------------

describe("createTask", () => {
	it("sends the recorded manifest, plus the one output format it ever asks for", async () => {
		const recorded = readMineruProtocolFixture<Recorded>(
			"samples/docx-default/01_create.json",
		);
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("samples/docx-default/01_create.json"),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });

		const receipt = await client.createTask({ ...DOCX, signal: never });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(`${RECORDED_ORIGIN}/v1/tasks`);
		expect(calls[0]?.headers["content-type"]).toBe("application/json");
		// What the spike sent, and S5's output_formats: ["default"], nothing else.
		expect(calls[0]?.body).toEqual({
			...(recorded.request.json as object),
			output_formats: ["default"],
		});
		expect(receipt.status).toBe("waiting-file");
		expect(receipt.files[0]?.upload?.url).toContain("/uploads/");
	});

	it("hands back a cache hit as it is: pending, and no upload object", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			replay("flows/hash-cache/B_same_hash_same_name_create.json"),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });
		const receipt = await client.createTask({
			fileName: "cache-a.pdf",
			bytes: 241697,
			sha256sum:
				"af87e5eeed1711d725c91dbe909ada044ddd25d8878949df9f01fbd327cf0c40",
			signal: never,
		});
		expect(receipt.status).toBe("pending");
		expect(receipt.files[0]?.upload).toBeUndefined();
	});

	it("sends the tier and the OCR mode only when it is given them", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("samples/docx-default/01_create.json"),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });
		await client.createTask({ ...DOCX, signal: never });
		await client.createTask({
			...DOCX,
			tier: "standard",
			ocrMode: "ocr",
			signal: never,
		});
		expect(Object.keys(calls[0]?.body as object).sort()).toEqual([
			"files",
			"output_formats",
		]);
		expect(calls[1]?.body).toMatchObject({ tier: "standard", ocr_mode: "ocr" });
	});

	it("never sends what S5 forbids, whatever it is given", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("samples/docx-default/01_create.json"),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });

		// Every shape createTask can produce: with and without each optional key.
		for (const tier of [undefined, "flash", "basic", "standard"] as const) {
			for (const ocrMode of [undefined, "txt", "ocr"] as const) {
				await client.createTask({ ...DOCX, tier, ocrMode, signal: never });
			}
		}
		// And what a caller that ignores the types could hand it: nulls, and a
		// field the 4.0 protocol had.
		await client.createTask({
			...DOCX,
			tier: null,
			ocrMode: null,
			page_range: "1-3",
			include_model_output: true,
			client_file_id: "c1",
			file_id: "f1",
			output_formats: ["markdown", "zip"],
			signal: never,
		} as never);

		expect(calls).toHaveLength(13);
		for (const call of calls) {
			const sent = call.body as {
				files: Array<Record<string, unknown>>;
				output_formats: unknown;
			} & Record<string, unknown>;
			// Top level: the manifest, the format, and optionally tier and ocr_mode.
			expect(
				Object.keys(sent).filter(
					(key) =>
						!["files", "output_formats", "tier", "ocr_mode"].includes(key),
				),
			).toEqual([]);
			expect(sent.output_formats).toEqual(["default"]);
			expect(sent.files).toHaveLength(1);
			expect(Object.keys(sent.files[0] ?? {}).sort()).toEqual([
				"bytes",
				"file_name",
				"sha256sum",
			]);
			// No null anywhere: ocr_mode:null, page_range:null and tier:null are 400s
			// or traps (D19), and "omitted" is the only way to say "you decide".
			expect(JSON.stringify(call.body)).not.toContain("null");
			for (const forbidden of [
				"include_model_output",
				"page_range",
				"client_file_id",
				"file_id",
				"callback",
			]) {
				expect(JSON.stringify(call.body)).not.toContain(forbidden);
			}
		}
		// Three tiers (and none) by three modes (and none) = 12, +1 for the sloppy caller.
		expect(
			calls.filter((call) => "tier" in (call.body as object)),
		).toHaveLength(9);
		expect(
			calls.filter((call) => "ocr_mode" in (call.body as object)),
		).toHaveLength(8);
	});

	it("has none of S5's names in the protocol source", () => {
		const source = readFileSync(join(__dirname, "client.ts"), "utf8");
		// Comments explain why they are never sent; code must not name them.
		const code = source
			.split("\n")
			.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
			.join("\n");
		for (const forbidden of [
			"include_model_output",
			"page_range",
			"client_file_id",
			"file_id",
			"callback",
		]) {
			expect(code, forbidden).not.toContain(forbidden);
		}
	});

	it("sends a name, never a path: directories, control characters and colons are dropped", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("samples/docx-default/01_create.json"),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });
		const sentName = async (fileName: string) => {
			await client.createTask({ ...DOCX, fileName, signal: never });
			const files = (
				calls.at(-1)?.body as { files: Array<{ file_name: string }> }
			).files;
			return files[0]?.file_name;
		};

		expect(await sentName("/Users/someone/data/knowledge/u-1/9f2c.pdf")).toBe(
			"9f2c.pdf",
		);
		expect(await sentName("C:\\Users\\someone\\9f2c.pdf")).toBe("9f2c.pdf");
		expect(await sentName("a:b\nc.pdf")).toBe("abc.pdf");
		expect(await sentName("  document.docx  ")).toBe("document.docx");
		expect(await sentName("../../etc/passwd")).toBe("passwd");
		expect(await sentName("")).toBe("document");
		expect(await sentName("///")).toBe("document");
		// 4.1 allows 1024 characters; more is cut, not rejected.
		const cut = await sentName(`${"a".repeat(2000)}.pdf`);
		expect(cut?.length).toBe(1024);
		expect(cut?.endsWith(".pdf")).toBe(true);
		// A name 4.1 accepts byte for byte is left alone, accents included.
		expect(await sentName("Árvíztűrő jelentés.pdf")).toBe(
			"Árvíztűrő jelentés.pdf",
		);
	});

	it("sends the key, as a Bearer token, on the configured origin", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("samples/docx-default/01_create.json"),
		);
		await new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		}).createTask({ ...DOCX, signal: never });
		expect(calls[0]?.headers.authorization).toBe("Bearer testkey");

		const anonymous = scriptedFetch(() =>
			replay("samples/docx-default/01_create.json"),
		);
		await new MineruClient({
			config: testConfig(),
			fetchImpl: anonymous.fetchImpl,
		}).createTask({ ...DOCX, signal: never });
		expect(anonymous.calls[0]?.headers.authorization).toBeUndefined();
	});

	it("does not retry a creation: it is not idempotent, and a lost 202 cannot be found again", async () => {
		const { fetchImpl, calls } = scriptedFetch(
			() => new Response("gateway", { status: 502 }),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });
		const error = await client
			.createTask({ ...DOCX, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect(error).toBeInstanceOf(MineruApiError);
		expect(calls).toHaveLength(1);
	});

	it("refuses a receipt that does not hold exactly the one file it asked for", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			replay("flows/partial-and-file-terminal/01_create.json"),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });
		const error = await client
			.createTask({ ...DOCX, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_schema_mismatch");
	});
});

describe("putTaskFile", () => {
	const recordedUpload = () => {
		const receipt = body("samples/docx-default/01_create.json") as {
			files: Array<{
				upload: {
					url: string;
					headers: Record<string, string>;
					expires_at: number;
				};
			}>;
		};
		return receipt.files[0]?.upload as {
			url: string;
			headers: Record<string, string>;
			expires_at: number;
		};
	};

	it("PUTs the bytes to the recorded link with the receipt's headers and the file's size", async () => {
		const file = sampleFile("x".repeat(777));
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("samples/docx-default/02_put_0.json"),
		);
		const client = new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		});

		const receipt = await client.putTaskFile({
			upload: recordedUpload(),
			filePathAbsolute: file.path,
			signal: never,
		});

		expect(calls).toHaveLength(1);
		const put = calls[0];
		expect(put?.method).toBe("PUT");
		expect(put?.url).toBe(recordedUpload().url);
		expect(put?.headers["content-type"]).toBe("application/octet-stream");
		expect(put?.headers["content-length"]).toBe("777");
		// Same origin as MINERU_API_URL, so the key travels (D10: the PUT is keyed).
		expect(put?.headers.authorization).toBe("Bearer testkey");
		// A streamed body, and a redirect is never followed with the bytes.
		expect(put?.body).toBe("<stream>");
		expect(put?.redirect).toBe("manual");
		expect(receipt).toEqual({
			task_id: "job_e25a30af18058622cc7715c7",
			file_id: "file-57ecb6bbc422eb333d3d3fc5",
			status: "pending",
		});
	});

	it("uses the receipt's headers verbatim, but not the ones the transport owns", async () => {
		const file = sampleFile("0123456789");
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("samples/docx-default/02_put_0.json"),
		);
		const upload = {
			...recordedUpload(),
			headers: {
				"Content-Type": "application/x-special",
				"X-Upload-Token": "abc",
				Authorization: "Bearer attacker",
				"Content-Length": "5",
				Host: "evil.example",
				Cookie: "a=b",
			},
		};
		await new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		}).putTaskFile({ upload, filePathAbsolute: file.path, signal: never });
		const headers = calls[0]?.headers ?? {};
		expect(headers["content-type"]).toBe("application/x-special");
		expect(headers["x-upload-token"]).toBe("abc");
		// Ours, not the server's.
		expect(headers.authorization).toBe("Bearer testkey");
		expect(headers["content-length"]).toBe("10");
		expect(headers.cookie).toBeUndefined();
		expect(headers.host).not.toBe("evil.example");

		// With no key configured the server still cannot write our credentials.
		await new MineruClient({ config: testConfig(), fetchImpl }).putTaskFile({
			upload,
			filePathAbsolute: file.path,
			signal: never,
		});
		expect(calls[1]?.headers.authorization).toBeUndefined();
	});

	it("falls back to an octet-stream content type when the receipt names none", async () => {
		const file = sampleFile();
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("samples/docx-default/02_put_0.json"),
		);
		await new MineruClient({ config: testConfig(), fetchImpl }).putTaskFile({
			upload: { ...recordedUpload(), headers: {} },
			filePathAbsolute: file.path,
			signal: never,
		});
		expect(calls[0]?.headers["content-type"]).toBe("application/octet-stream");
	});

	it.each([
		["a foreign origin", "http://attacker.example/v1/steal"],
		["another port on our host", "http://127.0.0.1:9999/v1/tasks/x/uploads/y"],
		["another scheme", "https://127.0.0.1:8012/v1/tasks/x/uploads/y"],
		[
			"a URL with credentials",
			"http://user:pass@127.0.0.1:8012/v1/tasks/x/uploads/y",
		],
		["a file URL", "file:///etc/passwd"],
		["an unparseable URL", "http://"],
	])("refuses an upload.url on %s, before sending a byte (S7)", async (_label, url) => {
		const { fetchImpl, calls } = scriptedFetch(() => {
			throw new Error("the client must not have sent anything");
		});
		const client = new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		});

		const error = await client
			.putTaskFile({
				upload: { ...recordedUpload(), url },
				filePathAbsolute: sampleFile().path,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);

		expect(calls).toHaveLength(0);
		expect(error).toBeInstanceOf(MineruApiError);
		expect((error as MineruApiError).code).toBe(
			"protocol_untrusted_upload_url",
		);
		expect((error as MineruApiError).message).not.toContain("testkey");
		const mapping = mapMineruError(error);
		expect(mapping.taxonomy).toBe("protocol");
		// Retrying a hostile or misconfigured server only repeats it.
		expect(mapping.retryable).toBe(false);
	});

	it("logs which host it refused, and never the key or the path", async () => {
		const { fetchImpl } = scriptedFetch(() => {
			throw new Error("the client must not have sent anything");
		});
		await new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		})
			.putTaskFile({
				upload: {
					...recordedUpload(),
					url: "http://attacker.example/v1/steal?key=testkey",
				},
				filePathAbsolute: sampleFile().path,
				signal: never,
			})
			.catch(() => undefined);
		expect(warn).toHaveBeenCalledTimes(1);
		const line = String(warn.mock.calls[0]?.[0]);
		expect(line).toContain(
			"an upload URL on a foreign origin: attacker.example",
		);
		expect(line).not.toContain("testkey");
		expect(line).not.toContain("/v1/steal");
	});

	it("resolves a RELATIVE upload.url against MINERU_API_URL", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("samples/docx-default/02_put_0.json"),
		);
		await new MineruClient({ config: testConfig(), fetchImpl }).putTaskFile({
			upload: { ...recordedUpload(), url: "/v1/tasks/job_x/uploads/file-y" },
			filePathAbsolute: sampleFile().path,
			signal: never,
		});
		expect(calls[0]?.url).toBe(
			`${RECORDED_ORIGIN}/v1/tasks/job_x/uploads/file-y`,
		);
	});

	it("does not follow a redirect with the bytes: it refuses it", async () => {
		const { fetchImpl, calls } = scriptedFetch(
			() =>
				new Response(null, {
					status: 307,
					headers: { location: "http://attacker.example/steal" },
				}),
		);
		const error = await new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		})
			.putTaskFile({
				upload: recordedUpload(),
				filePathAbsolute: sampleFile().path,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect(calls).toHaveLength(1);
		expect((error as MineruApiError).code).toBe("protocol_untrusted_redirect");
	});

	it("surfaces a wrong-size PUT as the recorded upload_size_mismatch, retryable", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			replay("errors/107_upload_size_short_by_one.json"),
		);
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.putTaskFile({
				upload: recordedUpload(),
				filePathAbsolute: sampleFile().path,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).status).toBe(400);
		expect((error as MineruApiError).code).toBe("upload_size_mismatch");
		expect(mapMineruError(error).retryable).toBe(true);
	});
});

describe("getTask and pollTask", () => {
	it("reads a snapshot from /v1/tasks/{id}", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("samples/docx-default/03_poll_02_completed.json"),
		);
		const task = await new MineruClient({
			config: testConfig(),
			fetchImpl,
		}).getTask({ taskId: "job_e25a30af18058622cc7715c7", signal: never });
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe(
			`${RECORDED_ORIGIN}/v1/tasks/job_e25a30af18058622cc7715c7`,
		);
		expect(task.status).toBe("completed");
		expect(task.files[0]?.result_url).toContain("/content");
	});

	it("encodes the task id into the path", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("errors/101_get_task_weird_id_slash.json"),
		);
		await new MineruClient({ config: testConfig(), fetchImpl })
			.getTask({ taskId: "job_a/b", signal: never })
			.catch(() => undefined);
		expect(calls[0]?.url).toBe(`${RECORDED_ORIGIN}/v1/tasks/job_a%2Fb`);
	});

	it("polls through running to the terminal snapshot and reports every poll", async () => {
		const sequence = [
			"samples/docx-default/03_poll_01_running.json",
			"samples/docx-default/03_poll_01_running.json",
			"samples/docx-default/03_poll_02_completed.json",
		];
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay(sequence[calls.length - 1] as string),
		);
		const seen: string[] = [];
		const task = await new MineruClient({
			config: testConfig(),
			fetchImpl,
		}).pollTask({
			taskId: "job_e25a30af18058622cc7715c7",
			signal: never,
			onPoll: (snapshot) => seen.push(snapshot.status),
		});
		expect(task.status).toBe("completed");
		expect(seen).toEqual(["running", "running", "completed"]);
		expect(calls).toHaveLength(3);
		expect(mapMineruTaskFailure(task)).toBeNull();
	});

	it("stops on every terminal status, partial and canceled included", async () => {
		for (const [name, status] of [
			["flows/partial-and-file-terminal/snapshot_02_partial.json", "partial"],
			["samples/pdf-corrupt-truncated/03_poll_02_failed.json", "failed"],
			["flows/cancel-running/11_get_after_cancel.json", "canceled"],
		] as const) {
			const { fetchImpl, calls } = scriptedFetch(() => replay(name));
			const task = await new MineruClient({
				config: testConfig(),
				fetchImpl,
			}).pollTask({
				taskId: "job_x",
				signal: never,
			});
			expect(task.status).toBe(status);
			expect(calls, name).toHaveLength(1);
		}
	});

	it("stops at once when the submitted file is still waiting for its bytes, and hands over the upload link", async () => {
		// In a one-file task only a PUT moves a file out of waiting-file, so
		// polling it can only run to the whole-job deadline (300 s by default).
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("flows/partial-and-file-terminal/06_get_before_good_upload.json"),
		);
		const seen: string[] = [];
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.pollTask({
				taskId: "job_x",
				signal: never,
				onPoll: (snapshot) => seen.push(snapshot.status),
			})
			.catch((caught) => caught as MineruApiError);

		// One request. The caller still saw the snapshot.
		expect(calls).toHaveLength(1);
		expect(seen).toEqual(["waiting-file"]);
		expect(error).toBeInstanceOf(MineruApiError);
		expect((error as MineruApiError).code).toBe(
			"client_file_waiting_for_bytes",
		);
		// The snapshot of a waiting file carries its upload link (captured), and
		// the error carries it on: PUT again with it.
		const snapshot = body(
			"flows/partial-and-file-terminal/06_get_before_good_upload.json",
		) as { files: Array<{ file_id: string; upload: MineruUploadLink }> };
		expect(mineruWaitingUpload(error)).toEqual(snapshot.files[0]?.upload);
		expect((error as MineruApiError).details).toMatchObject({
			taskId: "job_x",
			fileId: snapshot.files[0]?.file_id,
		});

		const mapping = mapMineruError(error);
		expect(mapping.rule).toBe("client:file-waiting");
		expect(mapping.known).toBe(true);
		expect(mapping.taxonomy).toBe("protocol");
		expect(mapping.retryable).toBe(true);
		// Unhandled, the next attempt must not resume this task: it never will move.
		expect(mapping.handleUnknown).toBe(true);
		expect(isMineruForgottenIdError(error)).toBe(false);
	});

	it("watches the file it is told to: another file waiting in the same task does not stop it", async () => {
		// 03_poll_after_bad: file 0 waits for bytes (with its link), file 1 runs.
		const snapshot = body(
			"flows/partial-and-file-terminal/03_poll_after_bad.json",
		) as { files: Array<{ file_id: string; status: string }> };
		const [waiting, running] = snapshot.files;
		expect([waiting?.status, running?.status]).toEqual([
			"waiting-file",
			"running",
		]);

		const sequence = [
			"flows/partial-and-file-terminal/03_poll_after_bad.json",
			"samples/docx-default/03_poll_02_completed.json",
		];
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay(sequence[calls.length - 1] as string),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });
		const task = await client.pollTask({
			taskId: "job_x",
			fileId: running?.file_id,
			signal: never,
		});
		expect(task.status).toBe("completed");
		expect(calls).toHaveLength(2);

		// Told to watch the waiting one, it stops on the first look.
		const again = scriptedFetch(() =>
			replay("flows/partial-and-file-terminal/03_poll_after_bad.json"),
		);
		const error = await new MineruClient({
			config: testConfig(),
			fetchImpl: again.fetchImpl,
		})
			.pollTask({ taskId: "job_x", fileId: waiting?.file_id, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe(
			"client_file_waiting_for_bytes",
		);
		expect(again.calls).toHaveLength(1);
	});

	it("a waiting file whose snapshot carries no link is reported without one: create the task again", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			jsonResponse({
				task_id: "job_x",
				status: "waiting-file",
				files: [
					{ file_id: "file-x", file_name: "x.pdf", status: "waiting-file" },
				],
			}),
		);
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.pollTask({ taskId: "job_x", signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe(
			"client_file_waiting_for_bytes",
		);
		expect(mineruWaitingUpload(error)).toBeNull();
	});

	it("does not stop at a waiting file inside a task that has already ended", async () => {
		// A canceled task is terminal whatever its files say; that is for
		// mapMineruTaskFailure to read, not for the poll to throw.
		const { fetchImpl } = scriptedFetch(() =>
			jsonResponse({
				task_id: "job_x",
				status: "canceled",
				files: [
					{ file_id: "file-x", file_name: "x.pdf", status: "waiting-file" },
				],
			}),
		);
		const task = await new MineruClient({
			config: testConfig(),
			fetchImpl,
		}).pollTask({ taskId: "job_x", signal: never });
		expect(task.status).toBe("canceled");
	});

	it("gives up at the whole-job deadline with a retryable timeout", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			replay("samples/docx-default/03_poll_01_running.json"),
		);
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.pollTask({ taskId: "job_x", signal: never, deadlineMs: 30 })
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_job_deadline_exceeded");
		const mapping = mapMineruError(error);
		expect(mapping.taxonomy).toBe("timeout");
		expect(mapping.retryable).toBe(true);
	});

	it("refuses a status it does not know instead of polling it until the deadline", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			jsonResponse({
				...body("samples/docx-default/03_poll_01_running.json"),
				status: "queued",
			}),
		);
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.pollTask({ taskId: "job_x", signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_schema_mismatch");
		expect(calls).toHaveLength(1);
	});
});

describe("cancelTask", () => {
	it("POSTs /v1/tasks/{id}/cancel with no body and returns the settled receipt", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("flows/cancel-midway/cancel_receipt.json"),
		);
		const receipt = await new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		}).cancelTask({ taskId: "job_f29210a095b46a21b936ba6c", signal: never });

		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(
			`${RECORDED_ORIGIN}/v1/tasks/job_f29210a095b46a21b936ba6c/cancel`,
		);
		expect(calls[0]?.body).toBeUndefined();
		expect(calls[0]?.headers["content-type"]).toBeUndefined();
		expect(calls[0]?.headers.authorization).toBe("Bearer testkey");
		expect(receipt?.status).toBe("canceled");
		expect(receipt?.files[0]?.status).toBe("completed");
		expect(receipt?.files[0]?.result_url).toBeTruthy();
	});

	it("swallows a cancel that is merely late: 409 task_already_terminal, 404 task_not_found, a FastAPI 404", async () => {
		for (const name of [
			"errors/121_cancel_finished_task.json",
			"flows/partial-and-file-terminal/08_cancel_partial_task.json",
			"errors/102_cancel_unknown_task.json",
			"flows/restart/06_R2_cancel_after_restart.json",
			"errors/49_removed_post_uploads.json",
		]) {
			const { fetchImpl } = scriptedFetch(() => replay(name));
			await expect(
				new MineruClient({ config: testConfig(), fetchImpl }).cancelTask({
					taskId: "job_x",
					signal: never,
				}),
				name,
			).resolves.toBeNull();
		}
	});

	it("still fails a cancel the server refused for another reason", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			replay("errors/01_auth_wrong_key_create.json"),
		);
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.cancelTask({ taskId: "job_x", signal: never })
			.catch((caught) => caught as MineruApiError);
		expect(mapMineruError(error).taxonomy).toBe("auth_failed");
	});
});

describe("downloadFile", () => {
	const zip = () =>
		readFileSync(join(MINERU_PROTOCOL_FIXTURE_ROOT, "zips", "v41-docx.zip"));
	const RESULT_URL = `${RECORDED_ORIGIN}/v1/files/file-57ecb6bbc422eb333d3d3fc5/content`;

	function zipResponse(extra: Record<string, string> = {}): Response {
		const bytes = zip();
		return new Response(bytes, {
			headers: {
				"content-type": "application/zip",
				"content-length": String(bytes.byteLength),
				...extra,
			},
		});
	}

	it("streams the result_url to disk, with the key, and reports the size", async () => {
		const { fetchImpl, calls } = scriptedFetch(() => zipResponse());
		const destination = join(tempDir(), "result.zip");
		const { bytes } = await new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		}).downloadFile({
			resultUrl: RESULT_URL,
			destinationPathAbsolute: destination,
			signal: never,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(RESULT_URL);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.headers.authorization).toBe("Bearer testkey");
		expect(bytes).toBe(zip().byteLength);
		expect((await stat(destination)).size).toBe(bytes);
		expect(readFileSync(destination).equals(zip())).toBe(true);
	});

	it.each([
		["a foreign origin", "http://attacker.example/v1/files/x/content"],
		["another port", "http://127.0.0.1:9999/v1/files/x/content"],
		["a file URL", "file:///etc/passwd"],
	])("refuses a result_url on %s before sending anything, key or not (S7)", async (_label, url) => {
		const { fetchImpl, calls } = scriptedFetch(() => {
			throw new Error("the client must not have sent anything");
		});
		const destination = join(tempDir(), "never.zip");
		const error = await new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		})
			.downloadFile({
				resultUrl: url,
				destinationPathAbsolute: destination,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);

		expect(calls).toHaveLength(0);
		expect((error as MineruApiError).code).toBe(
			"protocol_untrusted_result_url",
		);
		expect((error as MineruApiError).message).not.toContain("testkey");
		expect(mapMineruError(error).retryable).toBe(false);
		expect(existsSync(destination)).toBe(false);
	});

	it("follows one redirect on the configured origin, key and all", async () => {
		const target = `${RECORDED_ORIGIN}/v1/files/moved/content`;
		const { fetchImpl, calls } = scriptedFetch((call) =>
			call.url === RESULT_URL
				? new Response(null, { status: 302, headers: { location: target } })
				: zipResponse(),
		);
		const destination = join(tempDir(), "moved.zip");
		await new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		}).downloadFile({
			resultUrl: RESULT_URL,
			destinationPathAbsolute: destination,
			signal: never,
		});
		expect(calls.map((call) => call.url)).toEqual([RESULT_URL, target]);
		expect(calls.every((call) => call.redirect === "manual")).toBe(true);
		expect(calls[1]?.headers.authorization).toBe("Bearer testkey");
		expect(readFileSync(destination).equals(zip())).toBe(true);
	});

	it("refuses a redirect that leaves the configured origin: nothing is sent there", async () => {
		const { fetchImpl, calls } = scriptedFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "http://localhost:8012/v1/files/x/content" },
				}),
		);
		const destination = join(tempDir(), "x.zip");
		const error = await new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		})
			.downloadFile({
				resultUrl: RESULT_URL,
				destinationPathAbsolute: destination,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect(calls).toHaveLength(1);
		expect((error as MineruApiError).code).toBe("protocol_untrusted_redirect");
		expect(mapMineruError(error).retryable).toBe(false);
		expect(existsSync(destination)).toBe(false);
	});

	it("does not follow a second redirect", async () => {
		const { fetchImpl, calls } = scriptedFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: `${RECORDED_ORIGIN}/v1/files/again/content` },
				}),
		);
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.downloadFile({
				resultUrl: RESULT_URL,
				destinationPathAbsolute: join(tempDir(), "x.zip"),
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect(calls).toHaveLength(2);
		expect((error as MineruApiError).code).toBe("protocol_untrusted_redirect");
	});

	it("refuses a result that announces itself past the ceiling, before reading a byte", async () => {
		const { fetchImpl } = scriptedFetch(
			() =>
				new Response(
					new ReadableStream(
						{
							pull() {
								throw new Error("the body must not be read");
							},
						},
						{ highWaterMark: 0 },
					),
					{ headers: { "content-length": "500" } },
				),
		);
		const destination = join(tempDir(), "big.zip");
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.downloadFile({
				resultUrl: RESULT_URL,
				destinationPathAbsolute: destination,
				maxBytes: 100,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_download_too_large");
		expect(existsSync(destination)).toBe(false);
	});

	it("caps a stream that is longer than it said, and leaves nothing behind", async () => {
		const { fetchImpl } = scriptedFetch(
			() => new Response(new Uint8Array(500)),
		);
		const destination = join(tempDir(), "capped.zip");
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.downloadFile({
				resultUrl: RESULT_URL,
				destinationPathAbsolute: destination,
				maxBytes: 100,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_download_too_large");
		expect(existsSync(destination)).toBe(false);
	});

	it("rejects a download that is not the length the server announced, and removes it", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			zipResponse({ "content-length": String(zip().byteLength + 10) }),
		);
		const destination = join(tempDir(), "short.zip");
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.downloadFile({
				resultUrl: RESULT_URL,
				destinationPathAbsolute: destination,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_byte_count_mismatch");
		const mapping = mapMineruError(error);
		expect(mapping.taxonomy).toBe("protocol");
		expect(mapping.retryable).toBe(true);
		expect(existsSync(destination)).toBe(false);
	});

	it("does not hold a DECODED body to the length of the encoded one", async () => {
		// Content-Length counts the bytes on the wire; with a Content-Encoding
		// fetch hands over the decoded body, which is a different number.
		const { fetchImpl } = scriptedFetch(() =>
			zipResponse({ "content-encoding": "gzip", "content-length": "5" }),
		);
		const destination = join(tempDir(), "decoded.zip");
		const { bytes } = await new MineruClient({
			config: testConfig(),
			fetchImpl,
		}).downloadFile({
			resultUrl: RESULT_URL,
			destinationPathAbsolute: destination,
			signal: never,
		});
		expect(bytes).toBe(zip().byteLength);
		expect(readFileSync(destination).equals(zip())).toBe(true);
	});

	it("reads a result the server forgot as a forgotten id", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			replay("flows/restart/03_R1_result_url_after_restart.json"),
		);
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.downloadFile({
				resultUrl: RESULT_URL,
				destinationPathAbsolute: join(tempDir(), "gone.zip"),
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("file_not_found");
		expect(isMineruForgottenIdError(error)).toBe(true);
	});
});

/**
 * R14: MinerU 4.0.12 already serves /v1/tasks. Its answers are NOT captured (none
 * exists); they are derived from its source (see `MINERU_4_0_12_ERRORS`). A 4.1
 * client pointed at it during the cutover window must see "another protocol",
 * retryable, on every path, and never a forgotten id to re-create into the same
 * wall.
 */
describe("a 4.0.12 server answering a 4.1 client", () => {
	const answer = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

	function expectAnotherProtocol(error: unknown) {
		expect(error).toBeInstanceOf(MineruApiError);
		const mapping = mapMineruError(error);
		expect(mapping.rule).toBe("wrong-protocol");
		expect(mapping.taxonomy).toBe("unavailable");
		expect(mapping.retryable).toBe(true);
		expect(mapping.disposition).toBe("fail");
		expect(isMineruForgottenIdError(error)).toBe(false);
	}

	it("POST /v1/tasks: the 400 with error.type, once, is not our bug", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			answer(400, MINERU_4_0_12_ERRORS.invalidManifest),
		);
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.createTask({ ...DOCX, signal: never })
			.catch((caught) => caught);
		expectAnotherProtocol(error);
		// Not retried here, and the pydantic dump is not in the message.
		expect(calls).toHaveLength(1);
		expect((error as MineruApiError).message).not.toContain("pydantic");
	});

	it("GET /v1/tasks/{id}: its 404 task_not_found WITH a type is not a forgotten id", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			answer(404, MINERU_4_0_12_ERRORS.taskNotFound),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });
		const error = await client
			.getTask({ taskId: "job_x", signal: never })
			.catch((caught) => caught);
		expect((error as MineruApiError).code).toBe("task_not_found");
		expectAnotherProtocol(error);
		// A poll meets it on its first request and stops.
		const polled = await client
			.pollTask({ taskId: "job_x", signal: never })
			.catch((caught) => caught);
		expectAnotherProtocol(polled);
	});

	it("GET /v1/files/{id}/content: its 404 file_not_found WITH a type is not a forgotten id", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			answer(404, MINERU_4_0_12_ERRORS.fileNotFound),
		);
		const destination = join(tempDir(), "never.zip");
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.downloadFile({
				resultUrl: `${RECORDED_ORIGIN}/v1/files/file-x/content`,
				destinationPathAbsolute: destination,
				signal: never,
			})
			.catch((caught) => caught);
		expect((error as MineruApiError).code).toBe("file_not_found");
		expectAnotherProtocol(error);
		expect(existsSync(destination)).toBe(false);
	});

	it("PUT to an upload link and POST cancel: the routes it lacks answer FastAPI's 404", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			answer(404, MINERU_4_0_12_ERRORS.routeMissing),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });
		const put = await client
			.putTaskFile({
				upload: {
					url: `${RECORDED_ORIGIN}/v1/tasks/job_x/uploads/file-x`,
					headers: {},
				},
				filePathAbsolute: sampleFile().path,
				signal: never,
			})
			.catch((caught) => caught);
		expectAnotherProtocol(put);
		// A cancel of something the old server does not know is nothing to cancel.
		await expect(
			client.cancelTask({ taskId: "job_x", signal: never }),
		).resolves.toBeNull();
	});

	it("succeeds on its own once the URL points at 4.1: the cutover window, end to end", async () => {
		// The fake stands in for 4.0.12 for a request, then "the URL flips".
		const fake = await createFakeMineruServer({
			fixtureInput: "v41-csv",
			failures: [
				{
					path: "/v1/tasks",
					method: "POST",
					status: 400,
					body: MINERU_4_0_12_ERRORS.invalidManifest,
				},
			],
		});
		try {
			const client = new MineruClient({
				config: testConfig({ baseUrl: fake.baseUrl }),
			});
			const file = sampleFile();
			const create = async () =>
				client.createTask({
					fileName: "document.csv",
					bytes: file.bytes,
					sha256sum: await client.sha256(file.path),
					signal: never,
				});

			const during = await create().catch((caught) => caught);
			expectAnotherProtocol(during);

			fake.setOptions({ failures: [] });
			const receipt = await create();
			expect(receipt.status).toBe("waiting-file");
		} finally {
			await fake.close();
		}
	});
});

describe("capability reads", () => {
	it("reads task_output_formats and sources from /v1/health", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			replay("server/health_no_key.json"),
		);
		const health = await new MineruClient({
			config: testConfig(),
			fetchImpl,
		}).getHealth(never);
		expect(calls[0]?.url).toBe(`${RECORDED_ORIGIN}/v1/health`);
		expect(health.version).toBe("4.1.7");
		expect(health.features?.task_output_formats).toContain("default");
		expect(health.features?.sources).toEqual(["upload", "url"]);
	});

	it("reads the tiers and drops an id it does not know", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			jsonResponse({
				object: "list",
				data: [
					...(body("server/tiers.json").data as unknown[]),
					{ id: "quantum", description: "From a future server." },
				],
			}),
		);
		const tiers = await new MineruClient({
			config: testConfig(),
			fetchImpl,
		}).getTiers(never);
		expect(tiers.map((tier) => tier.id)).toEqual([
			"flash",
			"basic",
			"standard",
		]);
	});

	it("reads /v1/usage", async () => {
		const { fetchImpl } = scriptedFetch(() => replay("server/usage.json"));
		const usage = await new MineruClient({
			config: testConfig(),
			fetchImpl,
		}).getUsage(never);
		expect(usage.access_level).toBe("registered");
		expect(usage.limits?.max_concurrent_jobs).toBe(2);
	});

	it("rejects a 200 that is not the shape we recorded", async () => {
		const { fetchImpl } = scriptedFetch(() => replay("server/usage.json"));
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.getHealth(never)
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_schema_mismatch");
		const mapping = mapMineruError(error);
		expect(mapping.taxonomy).toBe("protocol");
		expect(mapping.retryable).toBe(true);
	});
});

describe("what an error carries", () => {
	it("keeps the code and the param of a rejected request, and not the pydantic dump", async () => {
		const { fetchImpl } = scriptedFetch(() =>
			replay("errors/14_filename_dotdot_slash.json"),
		);
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.createTask({ ...DOCX, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).status).toBe(400);
		expect((error as MineruApiError).code).toBe("invalid_request");
		expect((error as MineruApiError).param).toBe("files.0.file_name");
		expect((error as MineruApiError).requestPath).toBe("/v1/tasks");
		expect((error as MineruApiError).message).not.toContain("pydantic");
	});

	it("scrubs the API key from a body that echoes it, and truncates a long one", async () => {
		const { fetchImpl } = scriptedFetch(
			() =>
				new Response(`Bearer sk-secret-key ${"x".repeat(5000)}`, {
					status: 500,
				}),
		);
		const error = await new MineruClient({
			config: testConfig({ apiKey: "sk-secret-key" }),
			fetchImpl,
		})
			.getUsage(never)
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).message).not.toContain("sk-secret-key");
		expect((error as MineruApiError).bodyExcerpt).not.toContain(
			"sk-secret-key",
		);
		expect((error as MineruApiError).bodyExcerpt).toContain("[redacted]");
		expect((error as MineruApiError).bodyExcerpt?.length).toBeLessThanOrEqual(
			301,
		);
	});

	it("reads Retry-After in seconds, and in a date", async () => {
		for (const [header, expected] of [
			["3", 3000],
			[new Date(Date.now() + 10_000).toUTCString(), 10_000],
		] as const) {
			const { fetchImpl } = scriptedFetch(
				() =>
					new Response(
						JSON.stringify({
							error: { code: "rate_limit_exceeded", message: "slow down" },
						}),
						{ status: 429, headers: { "retry-after": header } },
					),
			);
			const error = await new MineruClient({ config: testConfig(), fetchImpl })
				.getUsage(never)
				.catch((caught) => caught as MineruApiError);
			const waited = (error as MineruApiError).retryAfterMs ?? -1;
			expect(Math.abs(waited - expected)).toBeLessThanOrEqual(1500);
			expect(mapMineruError(error).retryAfterMs).toBe(waited);
		}
	});

	it("does not leak the key through a transport failure", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("connect ECONNREFUSED http://x?key=sk-secret-key");
		}) as unknown as typeof fetch;
		const error = await new MineruClient({
			config: testConfig({ apiKey: "sk-secret-key" }),
			fetchImpl,
		})
			.getHealth(never)
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_transport_unreachable");
		expect((error as MineruApiError).message).not.toContain("sk-secret-key");
		expect(mapMineruError(error).taxonomy).toBe("unavailable");
	});

	it("reports a 200 that is not JSON", async () => {
		const { fetchImpl } = scriptedFetch(
			() => new Response("<html>hello</html>"),
		);
		const error = await new MineruClient({ config: testConfig(), fetchImpl })
			.getTask({ taskId: "job_x", signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_invalid_json");
	});
});

// ---------------------------------------------------------------------------
// 2. The fake 4.1 server
// ---------------------------------------------------------------------------

describe("against the fake 4.1 server", () => {
	let server: FakeMineruServer | null = null;

	afterEach(async () => {
		await server?.close();
		server = null;
	});

	async function start(
		options: FakeMineruServerOptions = {},
		configPatch: Partial<MineruConfig> = {},
	): Promise<{ server: FakeMineruServer; client: MineruClient }> {
		server = await createFakeMineruServer({
			fixtureInput: "v41-csv",
			...options,
		});
		return {
			server,
			client: new MineruClient({
				config: testConfig({ baseUrl: server.baseUrl, ...configPatch }),
			}),
		};
	}

	/** Creates a task for a file of these bytes and uploads it when asked to. */
	async function submit(client: MineruClient, file = sampleFile()) {
		const sha256 = await client.sha256(file.path);
		const receipt = await client.createTask({
			fileName: "document.csv",
			bytes: file.bytes,
			sha256sum: sha256,
			signal: never,
		});
		const first = receipt.files[0];
		if (first?.upload) {
			await client.putTaskFile({
				upload: first.upload,
				filePathAbsolute: file.path,
				signal: never,
			});
		}
		return {
			receipt,
			file,
			sha256,
			taskId: receipt.task_id,
			fileId: first?.file_id,
		};
	}

	it("runs the whole create, PUT, poll, download sequence over real HTTP", async () => {
		const { server: fake, client } = await start({ inProgressPolls: 2 });
		const { taskId, receipt } = await submit(client);
		expect(receipt.status).toBe("waiting-file");

		const polls: string[] = [];
		const task = await client.pollTask({
			taskId,
			signal: never,
			onPoll: (snapshot) => polls.push(snapshot.status),
		});
		expect(task.status).toBe("completed");
		// Two polls see the file in progress and the third sees it done: counted by
		// the server, so nothing here depends on how fast the machine is.
		expect(polls).toEqual(["pending", "running", "completed"]);
		expect(mapMineruTaskFailure(task)).toBeNull();
		expect(fake.tasks.get(taskId)?.status).toBe("completed");

		const destination = join(tempDir(), "result.zip");
		const resultUrl = task.files[0]?.result_url as string;
		const { bytes } = await client.downloadFile({
			resultUrl,
			destinationPathAbsolute: destination,
			signal: never,
		});
		const expected = readFileSync(
			join(MINERU_PROTOCOL_FIXTURE_ROOT, "zips", "v41-csv.zip"),
		);
		expect(bytes).toBe(expected.byteLength);
		expect(readFileSync(destination).equals(expected)).toBe(true);
	});

	it("sends the key on every call of a keyed server, and fails cleanly without one", async () => {
		const { server: fake, client } = await start(
			{ apiKey: "testkey" },
			{ apiKey: "testkey" },
		);
		const { taskId } = await submit(client);
		const task = await client.pollTask({ taskId, signal: never });
		await client.downloadFile({
			resultUrl: task.files[0]?.result_url as string,
			destinationPathAbsolute: join(tempDir(), "keyed.zip"),
			signal: never,
		});
		const keyed = fake.requests.filter(
			(request) => request.path !== "/v1/health",
		);
		expect(keyed.length).toBeGreaterThanOrEqual(4);
		expect(
			keyed.every(
				(request) => request.headers.authorization === "Bearer testkey",
			),
		).toBe(true);

		const anonymous = new MineruClient({
			config: testConfig({ baseUrl: fake.baseUrl }),
		});
		// /v1/health stays public even under --api-key.
		await expect(anonymous.getHealth(never)).resolves.toMatchObject({
			version: "4.1.7",
		});
		const error = await anonymous
			.getUsage(never)
			.catch((caught) => caught as MineruApiError);
		expect(mapMineruError(error).taxonomy).toBe("auth_failed");
		expect(mapMineruError(error).retryable).toBe(false);
		expect((error as MineruApiError).message).not.toContain("testkey");
		await expect(client.getUsage(never)).resolves.toMatchObject({
			access_level: "registered",
		});
	});

	it("skips the PUT when the server already holds the bytes, and mints new ids", async () => {
		const { server: fake, client } = await start();
		const first = await submit(client);
		fake.resetLog();

		const again = await submit(client, first.file);
		expect(again.receipt.status).toBe("pending");
		expect(again.receipt.files[0]?.upload).toBeUndefined();
		expect(again.taskId).not.toBe(first.taskId);
		expect(again.fileId).not.toBe(first.fileId);
		expect(fake.requests.filter((request) => request.method === "PUT")).toEqual(
			[],
		);

		const task = await client.pollTask({ taskId: again.taskId, signal: never });
		expect(task.status).toBe("completed");
	});

	it("recovers from a MinerU restart: every id is gone, and so is the hash cache", async () => {
		const { server: fake, client } = await start();
		const { taskId, file, sha256 } = await submit(client);
		const done = await client.pollTask({ taskId, signal: never });
		const resultUrl = done.files[0]?.result_url as string;

		fake.restart();

		// The task is gone…
		const gone = await client
			.getTask({ taskId, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((gone as MineruApiError).code).toBe("task_not_found");
		expect(isMineruForgottenIdError(gone)).toBe(true);
		expect(mapMineruError(gone).disposition).toBe("recover-by-reupload");
		// …and so is its result.
		const missing = await client
			.downloadFile({
				resultUrl,
				destinationPathAbsolute: join(tempDir(), "gone.zip"),
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((missing as MineruApiError).code).toBe("file_not_found");
		expect(isMineruForgottenIdError(missing)).toBe(true);

		// The recovery: create again. The hash cache went with the ids, so this is
		// a full upload again, not the 'pending' of a cache hit.
		fake.resetLog();
		const recovered = await client.createTask({
			fileName: "document.csv",
			bytes: file.bytes,
			sha256sum: sha256,
			signal: never,
		});
		expect(recovered.status).toBe("waiting-file");
		await client.putTaskFile({
			upload: uploadOf(recovered),
			filePathAbsolute: file.path,
			signal: never,
		});
		const finished = await client.pollTask({
			taskId: recovered.task_id,
			signal: never,
		});
		expect(finished.status).toBe("completed");
		expect(
			fake.requests.filter((request) => request.method === "PUT"),
		).toHaveLength(1);
	});

	it("meets the restart wherever it lands: before the PUT, and after it", async () => {
		const early = await start({ restartAfterFirstTask: true });
		const file = sampleFile();
		const created = await early.client.createTask({
			fileName: "document.csv",
			bytes: file.bytes,
			sha256sum: await early.client.sha256(file.path),
			signal: never,
		});
		const lost = await early.client
			.putTaskFile({
				upload: uploadOf(created),
				filePathAbsolute: file.path,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		// R2: the upload link outlived the task it belonged to.
		expect((lost as MineruApiError).code).toBe("task_not_found");
		expect(isMineruForgottenIdError(lost)).toBe(true);
		await server?.close();

		const late = await start({ restartAfterFirstUpload: true });
		const sent = await submit(late.client);
		const poll = await late.client
			.pollTask({ taskId: sent.taskId, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((poll as MineruApiError).code).toBe("task_not_found");
		expect(isMineruForgottenIdError(poll)).toBe(true);
	});

	it("meets a restart armed through setOptions after the flow is set up, which is how a recovery test arms it", async () => {
		const { server: fake, client } = await start();
		fake.setOptions({ restartAfterFirstUpload: true });
		const sent = await submit(client);
		const poll = await client
			.pollTask({ taskId: sent.taskId, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((poll as MineruApiError).code).toBe("task_not_found");
		expect(isMineruForgottenIdError(poll)).toBe(true);
		expect(fake.tasks.size).toBe(0);
	});

	it("a resumed attempt finds a task whose PUT never landed, stops, and finishes by PUTting again with the link it was handed", async () => {
		// The worker died between createTask and the PUT's 200 (or the PUT timed
		// out): the handle is stored, the file is waiting-file, and a poll would
		// wait out the whole-job deadline. This is what Task B does with the error.
		const { client } = await start({ inProgressPolls: 1 });
		const file = sampleFile();
		const receipt = await client.createTask({
			fileName: "document.csv",
			bytes: file.bytes,
			sha256sum: await client.sha256(file.path),
			signal: never,
		});
		const waiting = await client
			.pollTask({ taskId: receipt.task_id, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((waiting as MineruApiError).code).toBe(
			"client_file_waiting_for_bytes",
		);
		const link = mineruWaitingUpload(waiting);
		expect(link).toEqual(uploadOf(receipt));

		await client.putTaskFile({
			upload: link as MineruUploadLink,
			filePathAbsolute: file.path,
			signal: never,
		});
		const task = await client.pollTask({
			taskId: receipt.task_id,
			signal: never,
		});
		expect(task.status).toBe("completed");
		expect(mapMineruTaskFailure(task)).toBeNull();
	});

	it("a PUT the server refused leaves the file waiting; the same link cannot fix a file that no longer matches", async () => {
		// D13: a 400 upload_size_mismatch leaves the file waiting with its link.
		// Poll it and it is reported as waiting, with that link; PUT the same
		// bytes to it again and it is refused again, so the way out is a NEW task
		// declared from a fresh stat and hash.
		const { client } = await start();
		const file = sampleFile("a,b\n1,2\n3,4\n");
		const sha256 = await client.sha256(file.path);
		const receipt = await client.createTask({
			fileName: "document.csv",
			bytes: file.bytes + 1,
			sha256sum: sha256,
			signal: never,
		});
		const first = await client
			.putTaskFile({
				upload: uploadOf(receipt),
				filePathAbsolute: file.path,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((first as MineruApiError).code).toBe("upload_size_mismatch");

		const waiting = await client
			.pollTask({ taskId: receipt.task_id, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((waiting as MineruApiError).code).toBe(
			"client_file_waiting_for_bytes",
		);
		const link = mineruWaitingUpload(waiting) as MineruUploadLink;
		const again = await client
			.putTaskFile({ upload: link, filePathAbsolute: file.path, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((again as MineruApiError).code).toBe("upload_size_mismatch");

		const fresh = await client.createTask({
			fileName: "document.csv",
			bytes: file.bytes,
			sha256sum: sha256,
			signal: never,
		});
		await client.putTaskFile({
			upload: uploadOf(fresh),
			filePathAbsolute: file.path,
			signal: never,
		});
		const task = await client.pollTask({
			taskId: fresh.task_id,
			signal: never,
		});
		expect(task.status).toBe("completed");
	});

	it("cancels a task that is running, files and all, and swallows a second cancel", async () => {
		const { client } = await start({ neverFinish: true });
		const { taskId } = await submit(client);
		await client.getTask({ taskId, signal: never });
		expect((await client.getTask({ taskId, signal: never })).status).toBe(
			"running",
		);

		const receipt = await client.cancelTask({ taskId, signal: never });
		expect(receipt?.status).toBe("canceled");
		expect(receipt?.files.map((file) => file.status)).toEqual(["canceled"]);

		const after = await client.pollTask({ taskId, signal: never });
		expect(after.status).toBe("canceled");
		// A cancel WE asked for has a verdict of its own (null is a result to
		// download); someone else's is a failure.
		expect(mapMineruTaskFailure(after, { canceledByUs: true })?.rule).toBe(
			"task:canceled-by-us",
		);
		expect(mapMineruTaskFailure(after)?.rule).toBe(
			"task:canceled-by-someone-else",
		);

		await expect(
			client.cancelTask({ taskId, signal: never }),
		).resolves.toBeNull();
		await expect(
			client.cancelTask({
				taskId: "job_000000000000000000000000",
				signal: never,
			}),
		).resolves.toBeNull();
	});

	it("cancels a task that never got its bytes, and refuses the PUT that follows", async () => {
		const { client } = await start();
		const file = sampleFile();
		const receipt = await client.createTask({
			fileName: "document.csv",
			bytes: file.bytes,
			sha256sum: await client.sha256(file.path),
			signal: never,
		});
		const upload = uploadOf(receipt);
		expect(
			(await client.cancelTask({ taskId: receipt.task_id, signal: never }))
				?.status,
		).toBe("canceled");
		const error = await client
			.putTaskFile({ upload, filePathAbsolute: file.path, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).status).toBe(409);
		expect((error as MineruApiError).code).toBe("task_already_terminal");
		expect(mapMineruError(error).disposition).toBe("swallow");
	});

	it("reads a partial task, and hands each file its own verdict", async () => {
		const { server: fake, client } = await start({
			outcomeFor: ({ fileName }) =>
				fileName === "bad.pdf" ? "file-failed" : "completed",
			fileError: {
				message: "Failed to load document (PDFium: Data format error).",
			},
		});
		const good = Buffer.from("%PDF-1.7 good");
		const bad = Buffer.from("%PDF-1.7 bad!");
		const created = await fetch(`${fake.baseUrl}/v1/tasks`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				files: [
					{ file_name: "good.pdf", bytes: good.byteLength },
					{ file_name: "bad.pdf", bytes: bad.byteLength },
				],
			}),
		}).then(
			(response) =>
				response.json() as Promise<{
					task_id: string;
					files: Array<{ file_id: string; upload: { url: string } }>;
				}>,
		);
		for (const [index, content] of [good, bad].entries()) {
			await fetch(created.files[index]?.upload.url as string, {
				method: "PUT",
				body: new Uint8Array(content),
			});
		}

		const task = await client.pollTask({
			taskId: created.task_id,
			signal: never,
		});
		expect(task.status).toBe("partial");
		const [goodFile, badFile] = created.files;
		expect(
			mapMineruTaskFailure(task, { fileId: goodFile?.file_id }),
		).toBeNull();
		const failure = mapMineruTaskFailure(task, { fileId: badFile?.file_id });
		expect(failure?.taxonomy).toBe("document_unreadable");
		expect(failure?.retryable).toBe(false);
	});

	it("reads every way a file can fail the way the table says", async () => {
		const cases: Array<
			[string, { code?: string; message: string }, string, boolean]
		> = [
			[
				"corrupt",
				{ message: "Failed to load document (PDFium: Data format error)." },
				"document_unreadable",
				false,
			],
			[
				"encrypted",
				{
					message:
						"Failed to load document (PDFium: Incorrect password error).",
				},
				"document_unreadable",
				false,
			],
			[
				"unsupported",
				{ message: "Unsupported file type: notes.txt" },
				"unsupported_type",
				false,
			],
			[
				"xlsx",
				{ message: "Invalid XLSX package: file is not a ZIP archive." },
				"document_unreadable",
				false,
			],
			[
				"other",
				{ message: "All connection attempts failed" },
				"job_failed",
				true,
			],
		];
		for (const [label, fileError, taxonomy, retryable] of cases) {
			const { client } = await start({ outcome: "file-failed", fileError });
			const { taskId } = await submit(client);
			const task = await client.pollTask({ taskId, signal: never });
			expect(task.status, label).toBe("failed");
			const failure = mapMineruTaskFailure(task);
			expect(failure?.taxonomy, label).toBe(taxonomy);
			expect(failure?.retryable, label).toBe(retryable);
			await server?.close();
			server = null;
		}
	});

	it("fails a completed task that lost its result_url", async () => {
		const { client } = await start({ outcome: "completed-without-result-url" });
		const { taskId } = await submit(client);
		const task = await client.pollTask({ taskId, signal: never });
		expect(task.status).toBe("completed");
		expect(mapMineruTaskFailure(task)?.rule).toBe("task:missing-result-url");
	});

	it("stops polling at the whole-job deadline", async () => {
		const { client } = await start({ neverFinish: true });
		const { taskId } = await submit(client);
		const error = await client
			.pollTask({ taskId, signal: never, deadlineMs: 30 })
			.catch((caught) => caught as MineruApiError);
		expect(mapMineruError(error).taxonomy).toBe("timeout");
		expect(mapMineruError(error).retryable).toBe(true);
	});

	it("aborts in flight when the caller's signal fires", async () => {
		const { client } = await start({ neverFinish: true });
		const { taskId } = await submit(client);
		const controller = new AbortController();
		const polling = client.pollTask({ taskId, signal: controller.signal });
		controller.abort();
		const error = await polling.catch((caught) => caught);
		expect(mapMineruError(error).taxonomy).toBe("canceled");
		expect(mapMineruError(error).retryable).toBe(false);
	});

	it("reports a server that does not speak /v1/tasks as unavailable, once, not as a forgotten id", async () => {
		const { server: fake, client } = await start({
			failures: [
				{
					path: "/v1/tasks",
					method: "POST",
					fixture: "errors/49_removed_post_uploads.json",
				},
			],
		});
		const file = sampleFile();
		const error = await client
			.createTask({
				fileName: "document.csv",
				bytes: file.bytes,
				sha256sum: await client.sha256(file.path),
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).fastapi).toBe(true);
		expect((error as MineruApiError).status).toBe(404);
		expect(isMineruForgottenIdError(error)).toBe(false);
		const mapping = mapMineruError(error);
		expect(mapping.rule).toBe("wrong-protocol");
		expect(mapping.taxonomy).toBe("unavailable");
		expect(mapping.retryable).toBe(true);
		// The client does not retry creation by itself.
		expect(
			fake.requests.filter((request) => request.method === "POST"),
		).toHaveLength(1);
	});

	it("turns an unavailable tier into a tier error that is not retried", async () => {
		const { client } = await start({ tiers: ["flash"] });
		const file = sampleFile();
		const error = await client
			.createTask({
				fileName: "document.pdf",
				bytes: file.bytes,
				sha256sum: await client.sha256(file.path),
				tier: "standard",
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).status).toBe(400);
		expect((error as MineruApiError).param).toBe("tier");
		const mapping = mapMineruError(error);
		expect(mapping.taxonomy).toBe("tier_unavailable");
		expect(mapping.retryable).toBe(false);
	});

	it("will not PUT to an upload link on a foreign origin, nor send the key there (S7)", async () => {
		const { server: fake } = await start({
			urlOrigin: "cross-origin",
			apiKey: "testkey",
		});
		const client = new MineruClient({
			config: testConfig({ baseUrl: fake.baseUrl, apiKey: "testkey" }),
		});
		const file = sampleFile();
		const receipt = await client.createTask({
			fileName: "document.csv",
			bytes: file.bytes,
			sha256sum: await client.sha256(file.path),
			signal: never,
		});
		const upload = uploadOf(receipt);
		expect(upload.url.startsWith(fake.crossOriginBaseUrl)).toBe(true);

		const error = await client
			.putTaskFile({ upload, filePathAbsolute: file.path, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe(
			"protocol_untrusted_upload_url",
		);
		// Nothing reached the foreign hostname: no PUT, and so no key.
		expect(fake.requests.filter((request) => request.method === "PUT")).toEqual(
			[],
		);
		expect(
			fake.requests.some((request) =>
				request.headers.host?.startsWith("localhost"),
			),
		).toBe(false);
	});

	it("will not download from a result_url on a foreign origin, nor send the key there (S7)", async () => {
		const { server: fake } = await start({ apiKey: "testkey" });
		const client = new MineruClient({
			config: testConfig({ baseUrl: fake.baseUrl, apiKey: "testkey" }),
		});
		const { taskId } = await submit(client);
		await client.pollTask({ taskId, signal: never });

		fake.setOptions({ urlOrigin: "cross-origin" });
		const task = await client.getTask({ taskId, signal: never });
		const resultUrl = task.files[0]?.result_url as string;
		expect(resultUrl.startsWith(fake.crossOriginBaseUrl)).toBe(true);

		fake.resetLog();
		const error = await client
			.downloadFile({
				resultUrl,
				destinationPathAbsolute: join(tempDir(), "foreign.zip"),
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe(
			"protocol_untrusted_result_url",
		);
		expect(fake.requests).toEqual([]);
	});

	it("follows a same-origin download redirect, and refuses one that leaves the origin", async () => {
		const { server: fake, client } = await start({
			redirectDownloads: "same-origin",
		});
		const { taskId } = await submit(client);
		const task = await client.pollTask({ taskId, signal: never });
		const resultUrl = task.files[0]?.result_url as string;

		fake.resetLog();
		const { bytes } = await client.downloadFile({
			resultUrl,
			destinationPathAbsolute: join(tempDir(), "redirected.zip"),
			signal: never,
		});
		expect(bytes).toBeGreaterThan(0);
		expect(
			fake.requests.filter((request) => request.path.endsWith("/content")),
		).toHaveLength(2);

		fake.setOptions({ redirectDownloads: "cross-origin" });
		fake.resetLog();
		const error = await client
			.downloadFile({
				resultUrl,
				destinationPathAbsolute: join(tempDir(), "left.zip"),
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("protocol_untrusted_redirect");
		expect(fake.requests).toHaveLength(1);
	});

	/**
	 * The seam S0 left for this slice: `MineruClient` satisfies
	 * `MineruProbeClient` structurally, so the admin card's capability read goes
	 * through the real client with one line at module init. If a signature here
	 * ever drifts, this case stops compiling.
	 */
	it("satisfies MineruProbeClient, so the capability read can use it", async () => {
		const { server: fake } = await start();
		const factory: MineruProbeClientFactory = (config) =>
			new MineruClient({ config });
		setMineruProbeClientFactory(factory);
		resetMineruCapabilitiesCacheForTests();
		try {
			const report = await getMineruStatusReport({
				config: testConfig({ baseUrl: fake.baseUrl }),
			});
			expect(report.reachable).toBe(true);
			expect(report.version).toBe("4.1.7");
			expect(report.tiers.map((tier) => tier.id)).toEqual([
				"flash",
				"basic",
				"standard",
			]);
			expect(report.accessLevel).toBe("anonymous");
			// The origin only: never a key, never a path.
			expect(report.baseUrl).toBe(fake.baseUrl);
		} finally {
			setMineruProbeClientFactory(null);
			resetMineruCapabilitiesCacheForTests();
		}
	});
});
