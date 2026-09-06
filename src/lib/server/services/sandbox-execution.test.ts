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

function createEmptyOutputArchive(): Readable {
	return Readable.from(
		createTarArchive([
			{ name: "output/", content: Buffer.alloc(0), type: "directory" },
		]),
	);
}

function createTarArchive(
	files: Array<{
		name: string;
		content: Buffer;
		type?: string;
		linkname?: string;
	}>,
): Buffer {
	const chunks: Buffer[] = [];

	for (const file of files) {
		const header = Buffer.alloc(512);
		const nameBytes = Buffer.from(file.name, "utf-8");
		nameBytes.copy(header, 0);

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
			file.type === "symlink"
				? "2"
				: file.type === "link"
					? "1"
					: file.type === "char"
						? "3"
						: file.type === "block"
							? "4"
							: file.type === "directory"
								? "5"
								: "0";
		header.write(typeFlag, 156, "ascii");

		if (file.linkname) {
			const linknameBytes = Buffer.from(file.linkname, "utf-8");
			linknameBytes.copy(header, 157);
		}

		header.write("ustar", 257, "ascii");
		header.write("00", 263, "ascii");

		header.write("        ", 148, "ascii");
		let checksum = 0;
		for (let i = 0; i < 512; i++) {
			checksum += header[i];
		}
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");

		chunks.push(header);
		chunks.push(file.content);

		const padding = 512 - (file.content.length % 512);
		if (padding < 512) {
			chunks.push(Buffer.alloc(padding));
		}
	}

	chunks.push(Buffer.alloc(1024));

	return Buffer.concat(chunks);
}

describe("sandbox-execution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSandbox.destroy.mockResolvedValue(undefined);
		mockContainer.kill.mockResolvedValue(undefined);
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
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("executeCode", () => {
		it("returns stdout from successful Python execution", async () => {
			const mockResult: SandboxResult = {
				stdout: "Hello, World!",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());

			const result = await executeCode('print("Hello, World!")', "python");

			expect(result.stdout).toBe("Hello, World!");
			expect(result.stderr).toBe("");
			expect(result.error).toBeUndefined();
			expect(result.files).toEqual([]);
			expect(mockSandbox.destroy).toHaveBeenCalled();
		});

		it("returns stderr from failed Python execution", async () => {
			const mockResult: SandboxResult = {
				stdout: "",
				stderr: "SyntaxError: invalid syntax",
				exitCode: 1,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());

			const result = await executeCode('print("Hello"', "python");

			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("SyntaxError: invalid syntax");
			expect(result.error).toContain("Syntax error");
			expect(result.exitCode).toBe(1);
			expect(mockSandbox.destroy).toHaveBeenCalled();
		});

		it("includes stderr detail for generic non-zero exits", async () => {
			const mockResult: SandboxResult = {
				stdout: "Preparing presentation",
				stderr: "TypeError: pptx.writeFile is not a function",
				exitCode: 1,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());

			const result = await executeCode("makeDeck()", "javascript");

			expect(result.error).toContain("exit code 1");
			expect(result.error).toContain(
				"TypeError: pptx.writeFile is not a function",
			);
			expect(result.exitCode).toBe(1);
			expect(mockSandbox.destroy).toHaveBeenCalled();
		});

		it("returns actionable guidance for PptxGenJS object-shaped chart data failures", async () => {
			const mockResult: SandboxResult = {
				stdout: "",
				stderr:
					"TypeError: tmpData.forEach is not a function at addChartDefinition (/workspace/node_modules/pptxgenjs/dist/pptxgen.cjs.js:1698:13)",
				exitCode: 1,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());

			const result = await executeCode("makeDeck()", "javascript");

			expect(result.error).toContain("PptxGenJS chart data");
			expect(result.error).toContain("array of series objects");
			expect(result.error).toContain("slide.addChart");
			expect(result.exitCode).toBe(1);
		});

		it("handles timeout errors gracefully", async () => {
			mockSandbox.execute.mockImplementation(
				() =>
					new Promise((_, reject) => {
						setTimeout(
							() =>
								reject(new Error("Sandbox execution timed out after 60000ms")),
							10,
						);
					}),
			);
			mockContainer.getArchive.mockResolvedValue(null);

			const result = await executeCode("while True: pass", "python");

			expect(result.error).toContain("timed out");
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(mockSandbox.destroy).toHaveBeenCalled();
		});

		it("handles memory errors gracefully", async () => {
			const mockResult: SandboxResult = {
				stdout: "",
				stderr: "MemoryError",
				exitCode: 137,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());

			const result = await executeCode("x = [0] * 10**9", "python");

			expect(result.error).toContain("memory");
			expect(result.exitCode).toBe(137);
			expect(mockSandbox.destroy).toHaveBeenCalled();
		});

		it("extracts generated files from container", async () => {
			const mockResult: SandboxResult = {
				stdout: "File generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{ name: "output/report.pdf", content: Buffer.from("PDF content") },
			]);

			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			expect(result.stdout).toBe("File generated");
			expect(result.files.length).toBe(1);
			expect(result.files[0].filename).toBe("report.pdf");
			expect(mockSandbox.destroy).toHaveBeenCalled();
		});

		// run_python only surfaces stdout/stderr. Collecting /output for it costs
		// an in-container inspect, a tar pull, and — since a scratch script
		// writes no files, so the "succeeded but collected nothing" branch always
		// fires — a further 1.5s wait plus a second inspect, all discarded.
		it("skips output collection entirely when collectFiles is false", async () => {
			const mockResult: SandboxResult = {
				stdout: "42",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());

			const result = await executeCode("print(6 * 7)", "python", {
				collectFiles: false,
			});

			expect(result).toEqual({
				files: [],
				stdout: "42",
				stderr: "",
				exitCode: 0,
				error: undefined,
			});
			expect(mockContainer.getArchive).not.toHaveBeenCalled();
			// inspectOutputDirectory (both the first pass and the delayed
			// re-inspection) runs through executeSandboxCommand.
			expect(mockExecuteSandboxCommand).not.toHaveBeenCalled();
			expect(mockSandbox.destroy).toHaveBeenCalled();
		});

		it("still diagnoses a crashed script when collectFiles is false", async () => {
			mockSandbox.execute.mockResolvedValue({
				stdout: "",
				stderr: "SyntaxError: invalid syntax",
				exitCode: 1,
			} satisfies SandboxResult);

			const result = await executeCode("print(", "python", {
				collectFiles: false,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe("SyntaxError: invalid syntax");
			expect(result.error).toBeDefined();
		});

		it("collects output files by default (produce_file's program mode)", async () => {
			mockSandbox.execute.mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			} satisfies SandboxResult);
			mockContainer.getArchive.mockResolvedValue(
				Readable.from(
					createTarArchive([
						{ name: "output/report.pdf", content: Buffer.from("PDF") },
					]),
				),
			);

			const result = await executeCode('print("test")', "python");

			expect(result.files.map((file) => file.filename)).toEqual(["report.pdf"]);
		});

		it("assigns previewable MIME types to generated code artifacts", async () => {
			const mockResult: SandboxResult = {
				stdout: "Code files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{
					name: "output/theme.css",
					content: Buffer.from("body { color: red; }"),
				},
				{
					name: "output/widget.js",
					content: Buffer.from("export const answer = 42;"),
				},
				{
					name: "output/install.sh",
					content: Buffer.from("#!/usr/bin/env bash\n"),
				},
			]);

			mockContainer.getArchive.mockResolvedValue(Readable.from(tarContent));

			const result = await executeCode('print("test")', "python");

			expect(
				result.files.map((file) => [file.filename, file.mimeType]),
			).toEqual([
				["theme.css", "text/css"],
				["widget.js", "text/javascript"],
				["install.sh", "application/x-sh"],
			]);
		});

		it("wraps JavaScript code with sandbox helper names that do not collide with user fs variables", async () => {
			const mockResult: SandboxResult = {
				stdout: "ok",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());

			await executeCode(
				'const fs = require("fs"); fs.writeFileSync("/output/test.txt", "ok");',
				"javascript",
			);

			expect(mockSandbox.execute).toHaveBeenCalledWith(
				expect.stringContaining("const sandboxFs = require('fs');"),
			);
			expect(mockSandbox.execute).toHaveBeenCalledWith(
				expect.stringContaining(
					'const fs = require("fs"); fs.writeFileSync("/output/test.txt", "ok");',
				),
			);
		});

		it("wraps JavaScript code with a PptxGenJS chart data compatibility shim", async () => {
			const mockResult: SandboxResult = {
				stdout: "ok",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());

			await executeCode(
				'const PptxGenJS = require("pptxgenjs"); const pptx = new PptxGenJS(); const slide = pptx.addSlide(); slide.addChart(pptx.ChartType.bar, { labels: ["A"], values: [1] }, { x: 1, y: 1, w: 4, h: 3 });',
				"javascript",
			);

			expect(mockSandbox.execute).toHaveBeenCalledWith(
				expect.stringContaining("function sandboxNormalizePptxChartData"),
			);
			expect(mockSandbox.execute).toHaveBeenCalledWith(
				expect.stringContaining("function sandboxPatchPptxGenJsCharts"),
			);
			expect(mockSandbox.execute).toHaveBeenCalledWith(
				expect.stringContaining("slide.addChart(pptx.ChartType.bar"),
			);
			const wrappedCode = mockSandbox.execute.mock.calls[0][0] as string;
			expect(
				() => new Function("require", "process", wrappedCode),
			).not.toThrow();
		});

		it("extracts generated files after a leading directory entry", async () => {
			const mockResult: SandboxResult = {
				stdout: "File generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{ name: "output/", content: Buffer.alloc(0), type: "directory" },
				{ name: "output/report.pdf", content: Buffer.from("PDF content") },
			]);

			mockContainer.getArchive.mockResolvedValue(Readable.from(tarContent));

			const result = await executeCode('print("test")', "python");

			expect(result.files.length).toBe(1);
			expect(result.files[0].filename).toBe("report.pdf");
		});

		it("surfaces archive extraction failures instead of silently returning no files", async () => {
			const mockResult: SandboxResult = {
				stdout: "File generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockRejectedValue(
				new Error("Archive read failed"),
			);

			const result = await executeCode('print("test")', "python");

			expect(result.files).toEqual([]);
			expect(result.error).toContain("Failed to collect generated files");
			expect(result.error).toContain("Archive read failed");
		});

		it("falls back to in-container file reads when archive extraction misses visible files", async () => {
			const mockResult: SandboxResult = {
				stdout: "File generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());
			mockExecuteSandboxCommand
				.mockResolvedValueOnce({
					stdout: JSON.stringify({
						exists: true,
						isDir: true,
						directories: ["."],
						files: [
							{
								path: "/output/test.txt",
								relativePath: "test.txt",
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
								path: "/output/test.txt",
								filename: "test.txt",
								sizeBytes: 5,
								contentBase64: Buffer.from("hello").toString("base64"),
							},
						],
					}),
					stderr: "",
					exitCode: 0,
				});

			const result = await executeCode('print("test")', "python");

			expect(result.error).toBeUndefined();
			expect(result.files).toHaveLength(1);
			expect(result.files[0].filename).toBe("test.txt");
			expect(result.files[0].content.toString("utf-8")).toBe("hello");
		});

		it("returns an explicit backend collection error when files exist but fallback read still fails", async () => {
			const mockResult: SandboxResult = {
				stdout: "File generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());
			mockExecuteSandboxCommand
				.mockResolvedValueOnce({
					stdout: JSON.stringify({
						exists: true,
						isDir: true,
						directories: ["."],
						files: [
							{
								path: "/output/test.txt",
								relativePath: "test.txt",
								sizeBytes: 5,
							},
						],
					}),
					stderr: "",
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: "",
					stderr: "read failed",
					exitCode: 1,
				});

			const result = await executeCode('print("test")', "python");

			expect(result.files).toEqual([]);
			expect(result.error).toContain("Failed to collect generated files");
			expect(result.error).toContain("read failed");
		});

		it("destroys sandbox even when execution fails", async () => {
			mockSandbox.execute.mockRejectedValue(new Error("Unexpected error"));
			mockContainer.getArchive.mockResolvedValue(null);

			await executeCode('raise Exception("boom")', "python");

			expect(mockSandbox.destroy).toHaveBeenCalled();
		});

		it("supports javascript execution in the node sandbox", async () => {
			const mockResult: SandboxResult = {
				stdout: "Hello from Node",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);
			mockContainer.getArchive.mockResolvedValue(createEmptyOutputArchive());

			const result = await executeCode(
				'console.log("Hello from Node")',
				"javascript",
			);

			expect(result.stdout).toBe("Hello from Node");
			expect(mockCreateSandbox).toHaveBeenCalledWith("javascript");
		});

		it("rejects unsupported languages", async () => {
			const result = await executeCode('puts "hello"', "ruby" as "python");

			expect(result.error).toContain("Unsupported language");
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		});
	});

	describe("security tests", () => {
		it("rejects path traversal attempts in tar entries", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{ name: "../../../etc/passwd", content: Buffer.from("malicious") },
				{ name: "output/safe.txt", content: Buffer.from("safe content") },
			]);

			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			expect(result.files.length).toBe(1);
			expect(result.files[0].filename).toBe("safe.txt");
			expect(result.files.find((f) => f.filename === "passwd")).toBeUndefined();
		});

		it("rejects absolute paths in tar entries", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{ name: "/etc/shadow", content: Buffer.from("malicious") },
				{ name: "output/safe.txt", content: Buffer.from("safe content") },
			]);

			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			expect(result.files.length).toBe(1);
			expect(result.files[0].filename).toBe("safe.txt");
		});

		it("rejects symlink entries in tar", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{
					name: "output/malicious_link",
					content: Buffer.from(""),
					type: "symlink",
					linkname: "/etc/passwd",
				},
				{ name: "output/safe.txt", content: Buffer.from("safe content") },
			]);

			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			expect(result.files.length).toBe(1);
			expect(result.files[0].filename).toBe("safe.txt");
		});

		it("rejects hardlink entries in tar", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{
					name: "output/malicious_link",
					content: Buffer.from(""),
					type: "link",
					linkname: "/etc/passwd",
				},
				{ name: "output/safe.txt", content: Buffer.from("safe content") },
			]);

			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			expect(result.files.length).toBe(1);
			expect(result.files[0].filename).toBe("safe.txt");
		});

		it("rejects character device entries in tar", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{
					name: "output/malicious_dev",
					content: Buffer.from(""),
					type: "char",
				},
				{ name: "output/safe.txt", content: Buffer.from("safe content") },
			]);

			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			expect(result.files.length).toBe(1);
			expect(result.files[0].filename).toBe("safe.txt");
		});

		it("rejects block device entries in tar", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{
					name: "output/malicious_dev",
					content: Buffer.from(""),
					type: "block",
				},
				{ name: "output/safe.txt", content: Buffer.from("safe content") },
			]);

			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			expect(result.files.length).toBe(1);
			expect(result.files[0].filename).toBe("safe.txt");
		});

		it("enforces max files limit", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const files = [];
			for (let i = 0; i < 25; i++) {
				files.push({
					name: `output/file${i}.txt`,
					content: Buffer.from(`content ${i}`),
				});
			}

			const tarContent = createTarArchive(files);
			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			expect(result.files.length).toBe(20);
		});

		it("enforces max total bytes limit", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const files = [];
			for (let i = 0; i < 6; i++) {
				files.push({
					name: `output/large${i}.bin`,
					content: Buffer.alloc(10 * 1024 * 1024, "x"),
				});
			}

			const tarContent = createTarArchive(files);
			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			const totalBytes = result.files.reduce((sum, f) => sum + f.sizeBytes, 0);
			expect(totalBytes).toBeLessThanOrEqual(50 * 1024 * 1024);
		});

		it("enforces per-file size limit", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{
					name: "output/huge.bin",
					content: Buffer.alloc(51 * 1024 * 1024, "x"),
				},
				{ name: "output/small.txt", content: Buffer.from("small content") },
			]);

			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			expect(result.files.length).toBe(1);
			expect(result.files[0].filename).toBe("small.txt");
		});

		it("kills container on timeout", async () => {
			mockSandbox.execute.mockRejectedValue(
				new Error("Sandbox execution timed out after 60000ms"),
			);
			mockContainer.getArchive.mockResolvedValue(null);

			const result = await executeCode("while True: pass", "python");

			expect(result.error).toContain("timed out");
			expect(mockSandbox.destroy).toHaveBeenCalled();
		});

		it("rejects null bytes in path names", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const maliciousName = "output/normal" + "\0" + "evil.txt";
			const tarContent = createTarArchive([
				{ name: maliciousName, content: Buffer.from("malicious") },
				{ name: "output/safe.txt", content: Buffer.from("safe content") },
			]);

			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			const maliciousFile = result.files.find((f) =>
				f.filename.includes("evil"),
			);
			expect(maliciousFile).toBeUndefined();
		});

		it("extracts only basename from paths", async () => {
			const mockResult: SandboxResult = {
				stdout: "Files generated",
				stderr: "",
				exitCode: 0,
			};
			mockSandbox.execute.mockResolvedValue(mockResult);

			const tarContent = createTarArchive([
				{
					name: "output/subdir/deep/nested/file.txt",
					content: Buffer.from("nested content"),
				},
			]);

			const tarStream = Readable.from(tarContent);
			mockContainer.getArchive.mockResolvedValue(tarStream);

			const result = await executeCode('print("test")', "python");

			expect(result.files.length).toBe(1);
			expect(result.files[0].filename).toBe("file.txt");
		});
	});
});
