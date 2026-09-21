// What the sandbox's `[FILE_PRODUCTION]` lines are allowed to say.
//
// They carry ids, counts, codes and durations only — never a file name, never
// document text, because this log ends up in places the produced file is not
// allowed to reach. Output filenames in `/output` are chosen by the model, and
// through it by the user ("save it as Q3 layoffs.xlsx"), so a name in a log
// line is user content in a log line. The extension is kept because it says
// which writer produced the file, and it says nothing about whose file it is.
//
// The fixtures below use deliberately identifiable names so the negative
// assertions have teeth: a line that logged the name would fail loudly.
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxResult } from "../sandbox/config";

const mockContainer = vi.hoisted(() => ({
	id: "test-container-id",
	getArchive: vi.fn(),
	kill: vi.fn(),
}));

const mockSandbox = vi.hoisted(() => ({
	execute: vi.fn(),
	destroy: vi.fn(),
	container: mockContainer,
}));

vi.mock("../sandbox/config", () => ({
	createSandbox: vi.fn().mockResolvedValue(mockSandbox),
	executeSandboxCommand: vi.fn(),
	getSandboxTimeout: vi.fn().mockReturnValue(60000),
	SANDBOX_TIMEOUT_MS: 60000,
	SANDBOX_MEMORY_MB: 1024,
	SANDBOX_MAX_FILE_MB: 100,
	SANDBOX_MAX_OUTPUT_FILES: 20,
	SANDBOX_MAX_TOTAL_OUTPUT_MB: 50,
}));

import { createSandbox, executeSandboxCommand } from "../sandbox/config";
import { executeCode } from "./sandbox-execution";

const mockCreateSandbox = createSandbox as ReturnType<typeof vi.fn>;
const mockExecuteSandboxCommand = executeSandboxCommand as ReturnType<
	typeof vi.fn
>;

/** The name that must never reach a log line, and its stem. */
const SECRET_NAME = "Q3 layoffs and severance.xlsx";
const SECRET_STEM = "Q3 layoffs and severance";

type ConsoleSpy = { mock: { calls: unknown[][] } };
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function payloadsFor(spy: ConsoleSpy, message: string): unknown[] {
	return spy.mock.calls
		.filter((call) => String(call[0]) === message)
		.map((call) => call[1]);
}

/** Everything the three console spies were handed, as one string. */
function everythingLogged(): string {
	return [info, warn, errorSpy]
		.flatMap((spy) => (spy as unknown as ConsoleSpy).mock.calls)
		.map((call) => {
			try {
				return JSON.stringify(call);
			} catch {
				return String(call);
			}
		})
		.join("\n");
}

function emptyOutputArchive(): Readable {
	return Readable.from(
		createTarArchive([
			{ name: "output/", content: Buffer.alloc(0), type: "directory" },
		]),
	);
}

/** A minimal ustar writer — the same shape sandbox-execution.test.ts uses. */
function createTarArchive(
	files: Array<{ name: string; content: Buffer; type?: string }>,
): Buffer {
	const chunks: Buffer[] = [];

	for (const file of files) {
		const header = Buffer.alloc(512);
		Buffer.from(file.name, "utf-8").copy(header, 0);
		header.write("0000644", 100, "ascii");
		header.write("0000000", 108, "ascii");
		header.write("0000000", 116, "ascii");
		header.write(
			file.content.length.toString(8).padStart(11, "0"),
			124,
			"ascii",
		);
		header.write("00000000000", 136, "ascii");
		const typeFlag =
			file.type === "symlink" ? "2" : file.type === "directory" ? "5" : "0";
		header.write(typeFlag, 156, "ascii");
		header.write("ustar\0" + "00", 257, "ascii");

		let checksum = 0;
		header.fill(" ", 148, 156);
		for (const byte of header) checksum += byte;
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");

		chunks.push(header);
		if (file.content.length > 0) {
			const padded = Buffer.alloc(Math.ceil(file.content.length / 512) * 512);
			file.content.copy(padded);
			chunks.push(padded);
		}
	}

	chunks.push(Buffer.alloc(1024));
	return Buffer.concat(chunks);
}

function okResult(): SandboxResult {
	return { stdout: "File generated", stderr: "", exitCode: 0 };
}

describe("[FILE_PRODUCTION] sandbox log lines", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCreateSandbox.mockResolvedValue(mockSandbox);
		mockSandbox.execute.mockResolvedValue(okResult());
		info = vi.spyOn(console, "info").mockImplementation(() => {});
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports a missed extraction by count and extension, never by name", async () => {
		mockContainer.getArchive.mockResolvedValue(emptyOutputArchive());
		mockExecuteSandboxCommand
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					exists: true,
					isDir: true,
					directories: ["."],
					files: [
						{
							path: `/output/${SECRET_NAME}`,
							relativePath: SECRET_NAME,
							sizeBytes: 5,
						},
					],
				}),
				stderr: "",
				exitCode: 0,
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					files: [
						{
							path: `/output/${SECRET_NAME}`,
							filename: SECRET_NAME,
							sizeBytes: 5,
							contentBase64: Buffer.from("hello").toString("base64"),
						},
					],
				}),
				stderr: "",
				exitCode: 0,
			});

		const result = await executeCode('print("test")', "python");
		expect(result.files).toHaveLength(1);

		const [payload] = payloadsFor(
			info as unknown as ConsoleSpy,
			"[FILE_PRODUCTION] Archive extraction missed in-container output files; reading missing files in-container",
		);
		expect(payload).toMatchObject({
			containerId: "test-container-id",
			totalInspectionFiles: 1,
			extractedFiles: 0,
			missingFiles: 1,
			missingExtensions: ["xlsx"],
		});

		// The decisive assertion: the name is nowhere in ANY line.
		expect(everythingLogged()).not.toContain(SECRET_STEM);
		expect(everythingLogged()).not.toContain("/output/Q3");
	});

	it("reports a skipped archive entry by extension, never by name", async () => {
		// A symlink: rejected as a dangerous entry type, and logged.
		mockContainer.getArchive.mockResolvedValue(
			Readable.from(
				createTarArchive([
					{
						name: `output/${SECRET_NAME}`,
						content: Buffer.alloc(0),
						type: "symlink",
					},
				]),
			),
		);
		mockExecuteSandboxCommand.mockResolvedValue({
			stdout: JSON.stringify({
				exists: true,
				isDir: true,
				directories: ["."],
				files: [],
			}),
			stderr: "",
			exitCode: 0,
		});

		await executeCode('print("test")', "python");

		const payloads = payloadsFor(
			warn as unknown as ConsoleSpy,
			"[FILE_PRODUCTION] Skipping sandbox archive entry",
		);
		expect(payloads).toContainEqual(
			expect.objectContaining({
				containerId: "test-container-id",
				extension: "xlsx",
				reason: "dangerous-entry-type",
			}),
		);
		expect(everythingLogged()).not.toContain(SECRET_STEM);
	});

	it("reports a failed inspection by byte count, never by its path listing", async () => {
		mockContainer.getArchive.mockResolvedValue(emptyOutputArchive());
		// The inspection script's own stdout IS the listing of `/output` paths.
		mockExecuteSandboxCommand.mockResolvedValue({
			stdout: JSON.stringify({ files: [{ path: `/output/${SECRET_NAME}` }] }),
			stderr: `Traceback: open('/output/${SECRET_NAME}') failed`,
			exitCode: 1,
		});

		await executeCode('print("test")', "python");

		const [payload] = payloadsFor(
			warn as unknown as ConsoleSpy,
			"[FILE_PRODUCTION] In-container output inspection failed",
		);
		expect(payload).toMatchObject({
			containerId: "test-container-id",
			exitCode: 1,
		});
		expect(payload).toHaveProperty("stdoutBytes");
		expect(payload).toHaveProperty("stderrBytes");
		// Neither the preview fields nor the name they used to carry.
		expect(payload).not.toHaveProperty("stdoutPreview");
		expect(payload).not.toHaveProperty("stderrPreview");
		expect(everythingLogged()).not.toContain(SECRET_STEM);
	});

	// The in-container fallback read throws its script's STDERR as the error
	// message — an interpreter traceback over the `/output/<name>` paths it was
	// asked to open. That message was logged verbatim, which put a model-chosen
	// filename in the server log through the back door. It is now redacted for
	// the log; the full text still reaches the job's stored error.
	it("redacts the filenames out of a failed in-container read before logging it", async () => {
		mockContainer.getArchive.mockResolvedValue(emptyOutputArchive());
		const inspection = {
			stdout: JSON.stringify({
				exists: true,
				isDir: true,
				directories: ["."],
				files: [
					{
						path: `/output/${SECRET_NAME}`,
						relativePath: SECRET_NAME,
						sizeBytes: 5,
					},
				],
			}),
			stderr: "",
			exitCode: 0,
		};
		const failedReadback = {
			stdout: "",
			stderr: [
				"Traceback (most recent call last):",
				`  File "/tmp/readback.py", line 4, in <module>`,
				`    open('/output/${SECRET_NAME}', 'rb')`,
				`PermissionError: [Errno 13] Permission denied: '/output/${SECRET_NAME}'`,
			].join("\n"),
			exitCode: 1,
		};
		// The re-inspection that follows an empty collection finds nothing, so the
		// failure above is the verdict.
		mockExecuteSandboxCommand
			.mockResolvedValueOnce(inspection)
			.mockResolvedValueOnce(failedReadback)
			.mockResolvedValue({
				stdout: JSON.stringify({
					exists: true,
					isDir: true,
					directories: ["."],
					files: [],
				}),
				stderr: "",
				exitCode: 0,
			});

		const result = await executeCode('print("test")', "python");

		const [payload] = payloadsFor(
			warn as unknown as ConsoleSpy,
			"[FILE_PRODUCTION] In-container fallback read also failed; will attempt re-inspection if applicable",
		);
		expect(payload).toMatchObject({ containerId: "test-container-id" });
		const logged = (payload as { error: string }).error;
		// Still a diagnostic: the exception class and the errno survive.
		expect(logged).toContain("PermissionError");
		expect(logged).toContain("Errno 13");
		// …with every name taken out, extension kept.
		expect(logged).toContain("<file>.xlsx");
		expect(logged).not.toContain(SECRET_STEM);

		// And nowhere else either.
		expect(everythingLogged()).not.toContain(SECRET_STEM);
		expect(everythingLogged()).not.toContain("/output/Q3");

		// The user's own copy of the failure keeps the whole message.
		expect(result.error).toContain(SECRET_NAME);
	});

	it("caps a very long redacted excerpt", async () => {
		mockContainer.getArchive.mockResolvedValue(emptyOutputArchive());
		const inspection = {
			stdout: JSON.stringify({
				exists: true,
				isDir: true,
				directories: ["."],
				files: [
					{
						path: `/output/${SECRET_NAME}`,
						relativePath: SECRET_NAME,
						sizeBytes: 5,
					},
				],
			}),
			stderr: "",
			exitCode: 0,
		};
		mockExecuteSandboxCommand
			.mockResolvedValueOnce(inspection)
			.mockResolvedValueOnce({
				stdout: "",
				stderr: `RuntimeError: ${"x".repeat(5000)}`,
				exitCode: 1,
			})
			.mockResolvedValue(inspection);

		await executeCode('print("test")', "python");

		const [payload] = payloadsFor(
			warn as unknown as ConsoleSpy,
			"[FILE_PRODUCTION] In-container fallback read also failed; will attempt re-inspection if applicable",
		);
		const logged = (payload as { error: string }).error;
		expect(logged.length).toBeLessThanOrEqual(303);
		expect(logged.endsWith("...")).toBe(true);
	});
});
