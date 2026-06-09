import path from "node:path";
import type { Readable } from "node:stream";
import type { Container } from "dockerode";
import tar from "tar-stream";
import {
	createSandbox,
	executeSandboxCommand,
	getSandboxTimeout,
	SANDBOX_MAX_FILE_MB,
	SANDBOX_MAX_OUTPUT_FILES,
	SANDBOX_MAX_TOTAL_OUTPUT_MB,
	type SandboxLanguage,
} from "../sandbox/config";

export interface FileOutput {
	filename: string;
	mimeType: string;
	content: Buffer;
	sizeBytes: number;
}

export interface ExecutionResult {
	files: FileOutput[];
	stdout: string;
	stderr: string;
	exitCode?: number;
	error?: string;
}

const MIME_TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xls": "application/vnd.ms-excel",
	".pptx":
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".odt": "application/vnd.oasis.opendocument.text",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".cjs": "text/javascript",
	".jsx": "text/jsx",
	".py": "text/x-python",
	".ts": "application/typescript",
	".tsx": "text/tsx",
	".css": "text/css",
	".scss": "text/x-scss",
	".sass": "text/x-sass",
	".less": "text/x-less",
	".csv": "text/csv",
	".json": "application/json",
	".zip": "application/zip",
	".txt": "text/plain",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".xml": "application/xml",
	".rtf": "application/rtf",
	".svg": "image/svg+xml",
	".html": "text/html",
	".htm": "text/html",
	".yaml": "application/yaml",
	".yml": "application/yaml",
	".sh": "application/x-sh",
	".bash": "application/x-sh",
	".zsh": "application/x-sh",
	".sql": "application/sql",
	".graphql": "application/graphql",
	".gql": "application/graphql",
	".toml": "application/toml",
	".ini": "text/plain",
	".env": "text/plain",
	".conf": "text/plain",
	".log": "text/plain",
	".rb": "text/x-ruby",
	".rs": "text/rust",
	".go": "text/x-go",
	".java": "text/x-java-source",
	".kt": "text/x-kotlin",
	".kts": "text/x-kotlin",
	".swift": "text/x-swift",
	".cs": "text/x-csharp",
	".cpp": "text/x-c++src",
	".cxx": "text/x-c++src",
	".cc": "text/x-c++src",
	".c": "text/x-csrc",
	".h": "text/x-csrc",
	".hpp": "text/x-c++src",
	".php": "application/x-httpd-php",
	".r": "text/x-r-source",
};

const OUTPUT_DIR = "/output";
const MAX_ERROR_DETAIL_CHARS = 1600;
const PYTHON_OUTPUT_INSPECTION_SCRIPT = `
import json
import os

root = ${JSON.stringify(OUTPUT_DIR)}
files = []
directories = []

if os.path.isdir(root):
    for current_root, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(current_root, root)
        directories.append('.' if rel_dir == '.' else rel_dir.replace(os.sep, '/'))
        for filename in filenames:
            full_path = os.path.join(current_root, filename)
            rel_path = os.path.relpath(full_path, root).replace(os.sep, '/')
            stat = os.stat(full_path)
            files.append({
                "path": full_path,
                "relativePath": rel_path,
                "sizeBytes": stat.st_size,
            })

print(json.dumps({
    "exists": os.path.exists(root),
    "isDir": os.path.isdir(root),
    "directories": directories,
    "files": files,
}))
`;

const JAVASCRIPT_OUTPUT_INSPECTION_SCRIPT = `
const fs = require('fs');
const path = require('path');

const root = ${JSON.stringify(OUTPUT_DIR)};
const files = [];
const directories = [];

function walk(currentRoot) {
	const relDir = path.relative(root, currentRoot).split(path.sep).join('/');
	directories.push(relDir === '' ? '.' : relDir);

	for (const entry of fs.readdirSync(currentRoot, { withFileTypes: true })) {
		const fullPath = path.join(currentRoot, entry.name);
		if (entry.isDirectory()) {
			walk(fullPath);
			continue;
		}

		if (!entry.isFile()) {
			continue;
		}

		const stat = fs.statSync(fullPath);
		const relPath = path.relative(root, fullPath).split(path.sep).join('/');
		files.push({
			path: fullPath,
			relativePath: relPath,
			sizeBytes: stat.size,
		});
	}
}

const exists = fs.existsSync(root);
const isDir = exists ? fs.statSync(root).isDirectory() : false;
if (isDir) {
	walk(root);
}

console.log(JSON.stringify({ exists, isDir, directories, files }));
`;

interface OutputInspectionFile {
	path: string;
	relativePath: string;
	sizeBytes: number;
}

interface OutputInspectionResult {
	exists: boolean;
	isDir: boolean;
	directories: string[];
	files: OutputInspectionFile[];
}

interface OutputReadbackFile {
	path: string;
	filename: string;
	sizeBytes: number;
	contentBase64: string;
}

function fixDoubleEscapedQuotes(code: string): string {
	// Fix the most common model escaping error: writing \\' instead of \'
	// inside single-quoted strings.  e.g. 'Alföldy\\'s' → SyntaxError
	// because \\\\ produces a literal backslash and the next ' ends the string.
	// Reducing \\\\ + ' to \\ + ' turns it into an escaped apostrophe.
	return code.replace(/\\\\'/g, "\\'");
}

function buildSandboxBootstrapCode(
	code: string,
	language: SandboxLanguage,
): string {
	if (language === "javascript") {
		const sanitized = fixDoubleEscapedQuotes(code);
		return `
const sandboxFs = require('fs');
const sandboxModule = require('module');
const SANDBOX_OUTPUT_DIR = ${JSON.stringify(OUTPUT_DIR)};
const sandboxOriginalModuleLoad = sandboxModule._load;

function sandboxNormalizePptxSeries(series, labels, index) {
	if (!series || typeof series !== 'object') return series;
	const seriesLabels = Array.isArray(series.labels) ? series.labels : labels;
	const values = Array.isArray(series.values)
		? series.values
		: Array.isArray(series.data)
			? series.data
			: null;
	if (!Array.isArray(seriesLabels) || !Array.isArray(values)) return series;
	return {
		...series,
		name: series.name || series.label || series.title || \`Series \${index + 1}\`,
		labels: seriesLabels,
		values,
	};
}

function sandboxNormalizePptxChartData(data) {
	if (Array.isArray(data)) {
		return data.map((series, index) => sandboxNormalizePptxSeries(series, undefined, index));
	}
	if (!data || typeof data !== 'object') return data;

	const labels = Array.isArray(data.labels)
		? data.labels
		: Array.isArray(data.categories)
			? data.categories
			: Array.isArray(data.xLabels)
				? data.xLabels
				: undefined;
	if (Array.isArray(data.datasets)) {
		return data.datasets.map((series, index) => sandboxNormalizePptxSeries(series, labels, index));
	}
	if (Array.isArray(data.series)) {
		return data.series.map((series, index) => sandboxNormalizePptxSeries(series, labels, index));
	}
	return sandboxNormalizePptxSeries(data, labels, 0);
}

function sandboxNormalizePptxChartType(type) {
	if (!Array.isArray(type)) return type;
	return type.map((entry) => {
		if (!entry || typeof entry !== 'object') return entry;
		return { ...entry, data: sandboxNormalizePptxChartData(entry.data) };
	});
}

function sandboxPatchPptxGenJsCharts(PptxGenJS) {
	if (!PptxGenJS || typeof PptxGenJS !== 'function' || PptxGenJS.__alfyaiChartPatch) {
		return PptxGenJS;
	}
	const originalAddSlide = PptxGenJS.prototype && PptxGenJS.prototype.addSlide;
	if (typeof originalAddSlide !== 'function') return PptxGenJS;

	function patchSlide(slide) {
		if (!slide || typeof slide.addChart !== 'function' || slide.__alfyaiChartPatch) return slide;
		const originalAddChart = slide.addChart;
		Object.defineProperty(slide, '__alfyaiChartPatch', { value: true });
		slide.addChart = function patchedAddChart(type, data, opt) {
			const normalizedType = sandboxNormalizePptxChartType(type);
			const normalizedData = Array.isArray(type) ? data : sandboxNormalizePptxChartData(data);
			return originalAddChart.call(this, normalizedType, normalizedData, opt);
		};
		return slide;
	}

	PptxGenJS.prototype.addSlide = function patchedAddSlide(...args) {
		return patchSlide(originalAddSlide.apply(this, args));
	};
	Object.defineProperty(PptxGenJS, '__alfyaiChartPatch', { value: true });
	return PptxGenJS;
}

sandboxModule._load = function patchedSandboxModuleLoad(request, parent, isMain) {
	const loaded = sandboxOriginalModuleLoad.apply(this, arguments);
	if (request === 'pptxgenjs' || String(request).includes('pptxgenjs')) {
		sandboxPatchPptxGenJsCharts(loaded);
		if (loaded && typeof loaded === 'object' && loaded.default) {
			sandboxPatchPptxGenJsCharts(loaded.default);
		}
	}
	return loaded;
};

(async () => {
	sandboxFs.mkdirSync(SANDBOX_OUTPUT_DIR, { recursive: true });
	${sanitized}
	// Allow pending micro-tasks and async I/O to drain before Node exits
	await new Promise((r) => setTimeout(r, 500));
})().catch((error) => {
	console.error(error && error.stack ? error.stack : String(error));
	process.exit(1);
});
`;
	}

	return `
import os
os.makedirs('${OUTPUT_DIR}', exist_ok=True)

${code}
`;
}

function buildInspectionCommand(language: SandboxLanguage): string[] {
	if (language === "javascript") {
		return ["node", "-e", JAVASCRIPT_OUTPUT_INSPECTION_SCRIPT];
	}

	return ["python3", "-c", PYTHON_OUTPUT_INSPECTION_SCRIPT];
}

function buildReadbackCommand(
	language: SandboxLanguage,
	inspectionFiles: OutputInspectionFile[],
): string[] {
	if (language === "javascript") {
		const readbackScript = `
const fs = require('fs');
const path = require('path');

const paths = JSON.parse(${JSON.stringify(JSON.stringify(inspectionFiles.map((file) => file.path)))});
const files = paths.map((filePath) => {
	const content = fs.readFileSync(filePath);
	return {
		path: filePath,
		filename: path.basename(filePath),
		sizeBytes: content.length,
		contentBase64: content.toString('base64'),
	};
});

console.log(JSON.stringify({ files }));
`;

		return ["node", "-e", readbackScript];
	}

	const readbackScript = `
import base64
import json
import os

paths = json.loads(${JSON.stringify(JSON.stringify(inspectionFiles.map((file) => file.path)))})
files = []

for path in paths:
    with open(path, 'rb') as handle:
        content = handle.read()
    files.append({
        "path": path,
        "filename": os.path.basename(path),
        "sizeBytes": len(content),
        "contentBase64": base64.b64encode(content).decode('ascii'),
    })

print(json.dumps({"files": files}))
`;

	return ["python3", "-c", readbackScript];
}

function getMimeType(filename: string): string {
	const ext = path.extname(filename).toLowerCase();
	return MIME_TYPES[ext] || "application/octet-stream";
}

function compactErrorDetail(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > MAX_ERROR_DETAIL_CHARS
		? `${trimmed.slice(0, MAX_ERROR_DETAIL_CHARS)}...`
		: trimmed;
}

function formatNonZeroExitError(
	stderr: string,
	stdout: string,
	exitCode: number,
): string {
	const stderrDetail = compactErrorDetail(stderr);
	const stdoutDetail = compactErrorDetail(stdout);
	const details = [
		stderrDetail ? `stderr: ${stderrDetail}` : null,
		stdoutDetail ? `stdout: ${stdoutDetail}` : null,
	].filter((detail): detail is string => Boolean(detail));

	return details.length > 0
		? `Execution failed with exit code ${exitCode}: ${details.join(" | ")}`
		: `Execution failed with exit code ${exitCode}`;
}

function isPathTraversalAttempt(name: string): boolean {
	return (
		name.includes("..") ||
		path.isAbsolute(name) ||
		name.includes("\0") ||
		name.includes("\x00")
	);
}

function isDangerousEntryType(header: tar.Headers): boolean {
	return (
		header.type === "symlink" ||
		header.type === "link" ||
		header.type === "block-device" ||
		header.type === "character-device" ||
		header.type === "fifo"
	);
}

function isExtractableFileEntry(header: tar.Headers): boolean {
	return (
		header.type === "file" ||
		header.type === "contiguous-file" ||
		header.type == null
	);
}

function finishSkippedEntry(
	stream: Readable,
	next: (error?: unknown) => void,
): void {
	let done = false;

	const complete = (error?: unknown) => {
		if (done) return;
		done = true;
		next(error);
	};

	stream.once("end", () => complete());
	stream.once("close", () => complete());
	stream.once("error", (error) => complete(error));
	stream.resume();
}

async function extractFilesFromContainer(
	container: Container,
): Promise<FileOutput[]> {
	const files: FileOutput[] = [];
	const maxFileSizeBytes = SANDBOX_MAX_FILE_MB * 1024 * 1024;
	const maxTotalBytes = SANDBOX_MAX_TOTAL_OUTPUT_MB * 1024 * 1024;
	let totalBytes = 0;

	try {
		const archiveStream = await container.getArchive({ path: OUTPUT_DIR });

		return new Promise((resolve, reject) => {
			const extract = tar.extract();

			extract.on("entry", (header, stream, next) => {
				const name = header.name;
				const type = header.type ?? "file";

				// SECURITY: Reject dangerous entry types (symlinks, hardlinks, devices)
				if (isDangerousEntryType(header)) {
					console.warn("[FILE_PRODUCTION] Skipping sandbox archive entry", {
						containerId: container.id,
						name,
						type,
						reason: "dangerous-entry-type",
					});
					finishSkippedEntry(stream, next);
					return;
				}

				// SECURITY: Reject non-file entries (directories, pax headers, long-path metadata, etc.)
				if (!isExtractableFileEntry(header)) {
					finishSkippedEntry(stream, next);
					return;
				}

				// SECURITY: Reject path traversal attempts
				if (isPathTraversalAttempt(name)) {
					console.warn("[FILE_PRODUCTION] Skipping sandbox archive entry", {
						containerId: container.id,
						name,
						type,
						reason: "path-traversal",
					});
					finishSkippedEntry(stream, next);
					return;
				}

				// SECURITY: Check max files limit
				if (files.length >= SANDBOX_MAX_OUTPUT_FILES) {
					console.warn("[FILE_PRODUCTION] Skipping sandbox archive entry", {
						containerId: container.id,
						name,
						type,
						reason: "max-files-limit",
						maxFiles: SANDBOX_MAX_OUTPUT_FILES,
					});
					finishSkippedEntry(stream, next);
					return;
				}

				// Read file into memory (not to disk)
				const chunks: Buffer[] = [];
				let fileSize = 0;

				stream.on("data", (chunk: Buffer) => {
					fileSize += chunk.length;
					// SECURITY: Enforce per-file size limit during streaming
					if (fileSize <= maxFileSizeBytes) {
						chunks.push(chunk);
					}
				});

				stream.on("end", () => {
					// SECURITY: Skip files that exceed per-file size limit
					if (fileSize > maxFileSizeBytes) {
						console.warn("[FILE_PRODUCTION] Skipping sandbox archive entry", {
							containerId: container.id,
							name,
							type,
							reason: "max-file-size-limit",
							sizeBytes: fileSize,
							maxFileSizeBytes,
						});
						return next();
					}

					const content = Buffer.concat(chunks);

					// SECURITY: Check total output size limit
					if (totalBytes + content.length > maxTotalBytes) {
						console.warn("[FILE_PRODUCTION] Skipping sandbox archive entry", {
							containerId: container.id,
							name,
							type,
							reason: "max-total-size-limit",
							sizeBytes: content.length,
							totalBytes,
							maxTotalBytes,
						});
						return next();
					}

					totalBytes += content.length;

					// Extract just the filename (basename) to avoid any path components
					const filename = path.basename(name);

					files.push({
						filename,
						mimeType: getMimeType(filename),
						content,
						sizeBytes: content.length,
					});
					next();
				});

				stream.on("error", (error) => {
					console.warn("[FILE_PRODUCTION] Sandbox archive entry read failed", {
						containerId: container.id,
						name,
						type,
						error,
					});
					next();
				});
			});

			extract.on("finish", () => resolve(files));
			extract.on("error", (err: Error) => reject(err));

			archiveStream.on("error", (err: Error) => reject(err));
			archiveStream.pipe(extract);
		});
	} catch (error) {
		console.error("[FILE_PRODUCTION] Failed to read sandbox output archive", {
			containerId: container.id,
			outputDir: OUTPUT_DIR,
			error,
		});
		throw error;
	}
}

function classifyError(
	stderr: string,
	exitCode: number,
	stdout = "",
): string | undefined {
	if (
		exitCode === 137 ||
		stderr.includes("MemoryError") ||
		stderr.includes("OutOfMemoryError")
	) {
		return "Execution failed: memory limit exceeded";
	}

	if (stderr.includes("SyntaxError") || stderr.includes("IndentationError")) {
		return `Syntax error: ${stderr}`;
	}

	if (
		stderr.includes("ImportError") ||
		stderr.includes("ModuleNotFoundError")
	) {
		return `Import error: ${stderr}`;
	}

	if (
		stderr.includes("Cannot find module") ||
		stderr.includes("ERR_MODULE_NOT_FOUND")
	) {
		return `Import error: ${stderr}`;
	}
	if (stderr.includes("tmpData.forEach is not a function")) {
		return [
			"Execution failed: PptxGenJS chart data must be an array of series objects.",
			'Use slide.addChart(type, [{ name: "Series", labels: [...], values: [...] }], options) instead of passing a plain { labels, values } object.',
		].join(" ");
	}
	if (
		stderr.includes("sharp") ||
		stderr.includes("ENOMEM") ||
		stderr.includes("No space left on device") ||
		stderr.includes("ENOSPC")
	) {
		return "Execution failed: temporary storage exhausted during image processing";
	}

	if (
		exitCode === 0 &&
		(stderr.includes("UnhandledPromiseRejection") || stderr.includes("Promise"))
	) {
		return "Execution completed but an async file write may have been abandoned. Use synchronous writes (fs.writeFileSync) or ensure all Promises are awaited before the script ends.";
	}

	if (exitCode === 125 || exitCode === 126) {
		return "Execution failed: sandbox runtime error";
	}

	if (exitCode !== 0 && exitCode !== undefined) {
		return formatNonZeroExitError(stderr, stdout, exitCode);
	}

	return undefined;
}
async function inspectOutputDirectory(
	container: Container,
	language: SandboxLanguage,
): Promise<OutputInspectionResult | null> {
	const inspection = await executeSandboxCommand(
		container,
		buildInspectionCommand(language),
	);

	if (inspection.exitCode !== 0) {
		console.warn("[FILE_PRODUCTION] In-container output inspection failed", {
			containerId: container.id,
			exitCode: inspection.exitCode,
			stdoutPreview: inspection.stdout || null,
			stderrPreview: inspection.stderr || null,
		});
		return null;
	}

	if (!inspection.stdout) {
		console.warn(
			"[FILE_PRODUCTION] In-container output inspection returned no stdout",
			{
				containerId: container.id,
				stderrPreview: inspection.stderr || null,
			},
		);
		return null;
	}

	try {
		return JSON.parse(inspection.stdout) as OutputInspectionResult;
	} catch (error) {
		console.warn(
			"[FILE_PRODUCTION] In-container output inspection parse failed",
			{
				containerId: container.id,
				stdoutPreview: inspection.stdout.slice(0, 500),
				stderrPreview: inspection.stderr || null,
				error,
			},
		);
		return null;
	}
}

async function readFilesFromInsideContainer(
	container: Container,
	language: SandboxLanguage,
	inspectionFiles: OutputInspectionFile[],
): Promise<FileOutput[]> {
	const readback = await executeSandboxCommand(
		container,
		buildReadbackCommand(language, inspectionFiles),
	);

	if (readback.exitCode !== 0) {
		throw new Error(
			readback.stderr ||
				`In-container file read failed with exit code ${readback.exitCode}`,
		);
	}

	if (!readback.stdout) {
		throw new Error("In-container file read returned no stdout");
	}

	let parsed: { files: OutputReadbackFile[] };
	try {
		parsed = JSON.parse(readback.stdout) as { files: OutputReadbackFile[] };
	} catch (error) {
		throw new Error(
			`In-container file read returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const files: FileOutput[] = [];
	const maxFileSizeBytes = SANDBOX_MAX_FILE_MB * 1024 * 1024;
	const maxTotalBytes = SANDBOX_MAX_TOTAL_OUTPUT_MB * 1024 * 1024;
	let totalBytes = 0;

	for (const file of parsed.files) {
		if (files.length >= SANDBOX_MAX_OUTPUT_FILES) {
			console.warn("[FILE_PRODUCTION] Skipping in-container output file", {
				containerId: container.id,
				path: file.path,
				reason: "max-files-limit",
				maxFiles: SANDBOX_MAX_OUTPUT_FILES,
			});
			break;
		}

		const content = Buffer.from(file.contentBase64, "base64");
		if (content.length !== file.sizeBytes) {
			console.warn("[FILE_PRODUCTION] Skipping in-container output file", {
				containerId: container.id,
				path: file.path,
				reason: "size-mismatch",
				reportedSizeBytes: file.sizeBytes,
				decodedSizeBytes: content.length,
			});
			continue;
		}

		if (content.length > maxFileSizeBytes) {
			console.warn("[FILE_PRODUCTION] Skipping in-container output file", {
				containerId: container.id,
				path: file.path,
				reason: "max-file-size-limit",
				sizeBytes: content.length,
				maxFileSizeBytes,
			});
			continue;
		}

		if (totalBytes + content.length > maxTotalBytes) {
			console.warn("[FILE_PRODUCTION] Skipping in-container output file", {
				containerId: container.id,
				path: file.path,
				reason: "max-total-size-limit",
				sizeBytes: content.length,
				totalBytes,
				maxTotalBytes,
			});
			continue;
		}

		totalBytes += content.length;
		const filename = path.basename(file.filename);

		files.push({
			filename,
			mimeType: getMimeType(filename),
			content,
			sizeBytes: content.length,
		});
	}

	return files;
}

export async function executeCode(
	code: string,
	language: SandboxLanguage,
): Promise<ExecutionResult> {
	if (language !== "python" && language !== "javascript") {
		return {
			files: [],
			stdout: "",
			stderr: "",
			error: `Unsupported language: ${language}. Supported languages are 'python' and 'javascript'.`,
		};
	}

	const sandbox = await createSandbox(language);

	try {
		const wrappedCode = buildSandboxBootstrapCode(code, language);

		const result = await new Promise<{
			stdout: string;
			stderr: string;
			exitCode: number;
		}>((resolve, reject) => {
			const timeoutMs = getSandboxTimeout(language);
			const timeoutId = setTimeout(async () => {
				// SECURITY: Kill the container on timeout, not just reject
				try {
					await sandbox.container.kill({ signal: "SIGKILL" });
				} catch {
					// Container may already be stopped
				}
				reject(new Error(`Sandbox execution timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			sandbox
				.execute(wrappedCode)
				.then((res) => {
					clearTimeout(timeoutId);
					resolve(res);
				})
				.catch((err) => {
					clearTimeout(timeoutId);
					reject(err);
				});
		});

		const outputInspection =
			result.exitCode === 0
				? await inspectOutputDirectory(sandbox.container, language)
				: null;

		let files: FileOutput[] = [];
		let extractionError: string | undefined;
		try {
			files = await extractFilesFromContainer(sandbox.container);
		} catch (error) {
			extractionError = error instanceof Error ? error.message : String(error);
		}

		const inspectionFiles = outputInspection?.files ?? [];
		if (inspectionFiles.length > 0) {
			const extractedFilenames = new Set(
				files.map((f) => path.basename(f.filename)),
			);
			const missingFiles = inspectionFiles.filter(
				(f) => !extractedFilenames.has(path.basename(f.relativePath)),
			);
			if (missingFiles.length > 0) {
				console.info(
					"[FILE_PRODUCTION] Archive extraction missed in-container output files; reading missing files in-container",
					{
						containerId: sandbox.container.id,
						totalInspectionFiles: inspectionFiles.length,
						extractedFiles: files.length,
						missingFiles: missingFiles.length,
						missing: missingFiles,
					},
				);
				try {
					const missingFileOutputs = await readFilesFromInsideContainer(
						sandbox.container,
						language,
						missingFiles,
					);
					files = [...files, ...missingFileOutputs];
					extractionError = undefined;
				} catch (fallbackError) {
					extractionError =
						fallbackError instanceof Error
							? fallbackError.message
							: String(fallbackError);
					console.warn(
						"[FILE_PRODUCTION] In-container fallback read also failed; will attempt re-inspection if applicable",
						{
							containerId: sandbox.container.id,
							error:
								fallbackError instanceof Error
									? fallbackError.message
									: String(fallbackError),
						},
					);
				}
			}
		}

		// Re-inspection: if execution succeeded but no files were collected, wait briefly and retry once.
		// This mitigates JS async writes that finish after the process reports exit code 0.
		if (result.exitCode === 0 && files.length === 0) {
			await new Promise((r) => setTimeout(r, 1500));
			const reInspection = await inspectOutputDirectory(
				sandbox.container,
				language,
			);
			if (reInspection && reInspection.files.length > 0) {
				console.warn(
					"[FILE_PRODUCTION] Re-inspection found output files after initial empty result; retrying collection",
					{
						containerId: sandbox.container.id,
						fileCount: reInspection.files.length,
						files: reInspection.files,
					},
				);
				try {
					files = await readFilesFromInsideContainer(
						sandbox.container,
						language,
						reInspection.files,
					);
					extractionError = undefined;
				} catch (error) {
					extractionError =
						error instanceof Error ? error.message : String(error);
				}
			}
		}

		if (
			!extractionError &&
			files.length === 0 &&
			(outputInspection?.files.length ?? 0) > 0
		) {
			extractionError =
				"Generated files were visible inside the sandbox but could not be collected";
		}

		const error =
			classifyError(result.stderr, result.exitCode, result.stdout) ??
			(extractionError
				? `Failed to collect generated files: ${extractionError}`
				: undefined);

		return {
			files,
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
			error,
		};
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);

		if (errorMessage.includes("timed out")) {
			return {
				files: [],
				stdout: "",
				stderr: "",
				error: "Execution timed out",
			};
		}

		return {
			files: [],
			stdout: "",
			stderr: "",
			error: `Execution failed: ${errorMessage}`,
		};
	} finally {
		await sandbox.destroy();
	}
}
