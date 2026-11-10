# HEIC and HEIF decode in a worker thread: spec

2026-11-09. The follow-up named in `docs/plans/mineru-4-1/build-log.md` (Open items, "HEIC and HEIF") and in
`docs/uploads.md`. Production runs `e5a4db61a`, where HEIC and HEIF photos are decoded on the server's main thread.

## Why

`vision/prepare-image.ts` decodes HEIC/HEIF with `heic-convert` (libheif-js WebAssembly, then a pure-JS JPEG encode,
then `sharp`) on the calling thread, which on the server is the main one.

- Cost, measured 2026-11-09 on the box: 1.2 to 1.8 s of event loop per 12 MP photo, about 6 s and a 1.6 GB RSS peak per
  48 MP photo (libheif's heap is never returned). Chat streaming freezes meanwhile.
- The extraction runner decodes before the extractor's MinerU capability read, so every attempt pays it again,
  including each outage retry that only waits.
- A transparent HEIC comes out as a black page: libheif gives transparent pixels as RGBA 0,0,0,0 (measured: 465,892 of
  480,000 pixels of an 800x600 transparent page) and the JPEG step drops the alpha. The text is unreadable and the
  document reads as empty, with no error.
- libheif-js runs the real decode inside its own `setTimeout(…, 0)` (`HeifImage.display`). A throw or a WASM trap
  there is an uncaught exception, which exits Node, and leaves `heic-decode`'s promise unsettled.

## Measured for this design (this Mac, Node 22.23.4, `heic-decode` 2.1.0, `libheif-js` from the lockfile)

- A fresh `worker_threads` worker from an `eval` source that `require`s `heic-decode`: 30 to 37 ms to start and load
  libheif (25 ms of it the `require`). Cheap enough to start one per decode.
- Decode alone (no JPEG step) of a synthetic 12 MP, 512 px grid HEIC made by `sips`: 360 ms (1.1 MB file, `sips -s
  formatOptions 50`) to 540 ms (4 MB, default quality).
- RGBA from libheif is always 4 channels, `width*height*4` bytes, transferable to the main thread without a copy.
- Quality: against the source PNG of a synthetic 12 MP photo, the raw RGBA path scores PSNR 50.48 dB, the current JPEG
  hop 50.00 dB. The raw path is lossless from the decoder's output, so output quality holds and the JPEG step goes.
- `ispe` boxes of a `sips` grid HEIC: one `[512, 512]` (the tiles) and one `[4032, 3024]` (the image), inside
  `meta` > `iprp` > `ipco`, with `meta` before `mdat`.
- Vite 8 rewrites `new URL("./x", import.meta.url)` only for the client (`vite:asset-import-meta-url`,
  `applyToEnvironment: consumer === "client"`), so a worker FILE next to the source would not exist next to the built
  server chunk. `createRequire(import.meta.url)` does work in the production build (`connections/dav/xml.ts`).

## Decisions

- **D1 One worker per decode, from an `eval` source.** The worker source is a string constant run with
  `new Worker(source, { eval: true, workerData, transferList })`. It `require`s `heic-decode` by the absolute path the
  main side resolves with `createRequire(import.meta.url).resolve("heic-decode")`, passed in `workerData`. The worker
  decodes once, posts one answer, and is terminated by the main side. A fresh worker per decode returns libheif's heap
  to the OS when it ends, and a trap kills only that worker. The worker stays referenced while it decodes (a script
  that awaits a decode must not exit under it); the timeout bounds how long it can hold a shutdown.
- **D2 Only libheif runs in the worker.** It posts `{ ok: true, width, height, data }` with `data` the RGBA
  `ArrayBuffer` in the transfer list, or `{ ok: false, message }`. `sharp` stays on the main thread (it already works on
  libuv's pool): orientation, flatten, resize and encode.
- **D3 No JPEG step.** `sharp(rgba, { raw: { width, height, channels: 4 } })` replaces `heic-convert`. The dependency
  `heic-convert` 2.1.0 is replaced by `heic-decode` 2.1.0 (exact, already the version the lockfile resolves), and
  `vision/heic-convert.d.ts` is deleted. The lockfile changes only by that swap (libheif-js keeps its resolved version).
- **D4 A process-wide pool.** At most `HEIF_DECODE_CONCURRENCY = 2` decodes run at once; the rest wait in FIFO order.
  Each decode has `HEIF_DECODE_TIMEOUT_MS = 60_000`, counted from its worker's start, after which the worker is
  terminated (which really stops the WebAssembly) and the decode fails. The caller's `AbortSignal` ends a waiting
  decode (it never starts) or a running one (its worker is terminated); the decode then rejects with `signal.reason`,
  as `signal.throwIfAborted()` would. A worker `error` event (an uncaught throw, a trap in libheif's `setTimeout`, an
  out-of-memory), an `exit` before an answer, or a `messageerror` fails that decode only. Every promise is handled:
  `worker.terminate()` returns one, so it is always caught (Node 22 exits on an unhandled rejection). Nothing listens
  for `process` events.
- **D5 Transparency onto white for the reader.** `decodeImageToPng` gains `background?: string`: when set, the picture
  is flattened onto it (`sharp().flatten({ background })`). The extraction reader passes `#ffffff`. Without it a HEIC
  keeps its alpha, as a transparent PNG does today (preview, `make_image` inputs). `prepareImageForModel` already
  flattens onto white, and with raw input that now works for HEIC too.
- **D6 A pixel cap read before decoding.** `HEIF_MAX_PIXELS = 100_000_000` (100 MP: every phone photo, 48 and 50 MP
  ones included, and an iPhone panorama, fit; a decode of that size is about 1 GB in the worker). Before any worker
  starts, the main thread reads the HEIF box tree and takes the LARGEST `width*height` among all `ispe` boxes in
  `meta` > `iprp` > `ipco` (never less than the primary image's, whatever the item associations say). Over the cap:
  `ImageTooLargeError` (an `ImagePreparationError`), no worker. No `ispe` at all: `ImagePreparationError` (libheif
  refuses such a file too). The parser never throws on malformed input and never reads past the buffer: a malformed
  tree is "no `ispe`". The decoder's answer is checked as well: `width*height <= HEIF_MAX_PIXELS` and
  `data.byteLength === width*height*4`, else `ImagePreparationError`.
- **D7 The bytes are made when the extractor needs them.** `ExtractDocumentRequest` loses `filePathAbsolute`,
  `sizeBytes` and `contentSha256` and gains `openFile(): Promise<ExtractionFile>` (below). The runner's reader input
  is lazy: for a HEIC, `openFile` is the decode and the write of the temp PNG, once per attempt (memoized). MinerU
  calls it where it first needs bytes, after the capability read and the tier decision: for the digest when the
  resumed handle has none, for `createTask`'s size, and for each PUT. So an attempt that fails its capability read
  (an outage wait) never decodes, and a resumed attempt that only polls a live task never decodes. The direct-text
  extractor calls it first. A `DocumentExtractionError` thrown by `openFile` reaches the ledger unchanged (MinerU's
  `failureFrom` already returns one as it is).
- **D8 The digest on resume.** MinerU's step 3 takes the resumed handle's digest when it has one (it is the digest the
  live task was declared with) and opens the file only when it has none, then uses the file's `contentSha256` or
  hashes it. Today's order (the ledger's digest first) gives the same digest for a stored file, which never changes;
  a converted PNG has no ledger digest either way.
- **D9 Failures of a photo's decode, for the ledger.** `ImageTooLargeError` is the new code `image_too_large`, not
  retryable. A decode timeout is `job_failed`, retryable (it spends an attempt: a slow box gets another try, a file
  that always hangs ends after the attempt budget). Any other `ImagePreparationError` (libheif refused the file, the
  worker crashed or exited) stays `document_unreadable`, not retryable, as today. An abort is rethrown as it is. A
  file that cannot be read or written stays `unavailable` with its fixed sentence, as today.
- **D10 Callers outside the reader keep their behavior.** `prepareImageForModel` and `decodeImageToPng` take an
  optional `signal`; only the reader passes one. A picture that cannot be prepared is still left out and logged
  (`turn-images.ts`, `photo-look.ts`), a preview still answers null. `heif-preview.ts` keeps its queue (it shares one
  conversion among the three requests a photo makes); its reason is no longer the calling thread.

## Contracts

```ts
// vision/image-errors.ts (a leaf module: prepare-image.ts and heif-decode.ts both import it, so no cycle)
export class ImagePreparationError extends Error {}             // moved here; still importable from prepare-image.ts
export class ImageTooLargeError extends ImagePreparationError { readonly pixels: number; readonly limit: number }
export class ImageDecodeTimeoutError extends ImagePreparationError { readonly timeoutMs: number }

// vision/decode-pool.ts: runs a one-answer worker source with bounded concurrency (generic, no HEIF knowledge)
export interface DecodePoolOptions { concurrency: number; timeoutMs: number; source: string }
export function createDecodePool(options: DecodePoolOptions): {
	run<T>(job: { workerData: unknown; transferList?: Transferable[]; signal?: AbortSignal }): Promise<T>; // the worker's first message
	readonly running: number; // for tests
	readonly waiting: number; // for tests
};

// vision/heif-decode.ts
export const HEIF_MAX_PIXELS = 100_000_000;
export function readHeifPixelCount(bytes: Uint8Array): number | null; // largest ispe area, null when there is none
export function decodeHeifToRgba(
	input: Uint8Array, // may be a view into a larger buffer: copy the view (input.slice()) and transfer the copy
	options?: { signal?: AbortSignal },
): Promise<{ width: number; height: number; data: Uint8Array }>; // RGBA, width*height*4

// vision/prepare-image.ts (signatures grow, nothing else changes for callers)
decodeImageToPng(input, mimeType, options?: { maxLongEdge?: number; background?: string; signal?: AbortSignal })
prepareImageForModel(input, mimeType, options: { maxLongEdge: number; signal?: AbortSignal })

// extraction/contracts.ts
export interface ExtractionFile {
	filePathAbsolute: string;
	sizeBytes: number;
	/** Verified SHA-256 (lowercase hex) of these bytes when the ledger holds it; null: hash the file. */
	contentSha256: string | null;
}
// ExtractDocumentRequest: `openFile(): Promise<ExtractionFile>` replaces filePathAbsolute, sizeBytes, contentSha256.
// fileName and mimeType stay: what the reader is told (the stored name, or the converted file's: IMG_1.png, image/png).

// extraction/reader-input.ts
prepareReaderInput(params): { fileName: string; mimeType: string | null; openFile(): Promise<ExtractionFile>; release(): Promise<void> }
// params as today plus `signal: AbortSignal`. No I/O until openFile. openFile is memoized; release never throws, may be
// called again, waits for an openFile in flight and then removes the file; an openFile after release rejects; a decode
// the signal stopped writes no file.
```

Names are the builders' to change if a better one fits; the shapes are not.

## The user's sentences (code `image_too_large`)

- Ledger (`EXTRACTION_ERROR_MESSAGES` in `extraction/contracts.ts`), Library row EN (`knowledge.extraction.error.image_too_large`):
  "This photo is larger than 100 megapixels, so it could not be read. Save a smaller copy and upload that."
- Library row HU: "Ez a fotó nagyobb 100 megapixelnél, ezért nem sikerült beolvasni. Ments el belőle egy kisebb
  példányt, és azt töltsd fel."
- Composer chip (`chat.extraction.error.image_too_large`) EN "Photo too large to read", HU "A fotó túl nagy a
  beolvasáshoz".
- Policy: like `too_large` (no auto-retry, not user-retryable). A test holds the 100 in these sentences to
  `HEIF_MAX_PIXELS`.

## Tests (each written first and seen failing, against today's code where it exists)

Slice A, the decoder:

- A1 `readHeifPixelCount`: `tiny.heic` is 2,688; the grid fixture is its full size, not a tile's; no `meta`, a box
  whose size runs past the buffer, a zero-length or truncated buffer: null, no throw; a 64-bit `largesize` box and a
  size-0 last box are read.
- A2 Over the cap: `tiny.heic` with its `ispe` patched to 10,001 x 10,000 fails with `ImageTooLargeError` before any
  worker starts (the pool's counters, or a spy, show none).
- A3 An opaque photo's PNG is byte-stable: two `decodeImageToPng(…, { background: "#ffffff" })` calls (two workers)
  give identical bytes, with no alpha, and the same RGB pixels as the decode without `background`.
- A4 A transparent HEIC comes out white-backed: corners 255,255,255, the text dark, `hasAlpha` false, through both
  `decodeImageToPng` with `background` and `prepareImageForModel`. Without `background`, `hasAlpha` is true. Today the
  corners are black.
- A5 The main thread stays responsive during a real decode of the medium fixture: `monitorEventLoopDelay`
  (resolution 10 ms), kept enabled until a timer after the decode settles, so the last lag is recorded. Assert the
  maximum delay is under half the decode's own duration (relative, so a loaded machine slows both), and that the
  decode took at least 100 ms (else the test proves nothing). It must fail against today's main-thread decode.
- A6 The pool, with small test sources and short injected timeouts (never a lengthened test timeout): a third job
  waits while two run and starts when one ends; a `for (;;) {}` worker is terminated at the timeout (`exit` fires, the
  next job runs); a throw inside the worker's `setTimeout` fails that job only, the next job runs, and vitest reports
  no unhandled error; `process.exit(7)` in the worker fails that job; an abort while waiting fails it without starting
  a worker; an abort while running terminates the worker.
- The existing `prepare-image.test.ts` HEIC tests keep passing (quadrant colors, brands, a view into a larger buffer,
  the `hevc` brand case).

Slice B, the document path:

- B1 An attempt whose capability read fails (an outage) never decodes and leaves no temp PNG (real MinerU extractor,
  the fake server; a spy on `decodeImageToPng`).
- B2 The decode comes after the capability read (order of the two calls).
- B3 A resumed attempt that polls a live task to completion never decodes.
- B4 At the runner level, through the engine: a cancel while the extractor holds the opened PNG removes it, and so
  does a lost lease (`recover` with `staleBefore`, the existing claim-lost pattern in `extraction-runner.test.ts`).
  The file is `alfyai-reader-input-<attemptId>.png` in `os.tmpdir()`, unique per attempt.
- B5 A cancel during the decode stops it (the worker is terminated) and no PNG is ever written.
- B6 A photo over the cap fails the job with `image_too_large`, not retryable, with the ledger sentence, and no
  worker starts.
- B7 A decode timeout fails as `job_failed`, retryable (the decode may be stubbed to throw `ImageDecodeTimeoutError`).
- B8 A HEIC that libheif refuses still fails as `document_unreadable` through the real MinerU extractor (an
  `openFile` error passes through unchanged).
- B9 Today's reader-input guarantees keep their tests: the converted name and type, mode `0o600`, the prefix the
  sweep reads, `release` safe to call twice, the stored file untouched, a missing original as `unavailable`.
- B10 The new code is complete: shared taxonomy and policy, the Library row key, the chip key, EN and HU.

## Docs to bring up to date

`vision/AGENTS.md` (the "calling thread" sentence of The current message, and the extraction-runner bullet: worker,
cap, `background`), comments in `prepare-image.ts`, `turn-images.ts`, `photo-look.ts`, `heif-preview.ts` and its test
title, `extraction/reader-input.ts`'s header, `shared/file-types/types.ts`'s `readAs` comment if it describes the
timing, `docs/uploads.md` (the cost paragraph), and the build log's Open item "HEIC and HEIF" (what is done, with
commits). Historical plans under `docs/plans/image-generation/` stay as they are.

## Not in this change

Refusing an over-limit photo at upload; a setting for the cap, the concurrency or the timeout (constants, each with
its reason); sharp in the worker; reusing warm workers; anything about what MinerU is sent (`document.png`); AVIF;
re-extracting documents read before this change; push or deploy.

## Slices and file ownership

- **Slice A (decoder):** `src/lib/server/services/vision/*` (new `image-errors.ts`, `decode-pool.ts`,
  `heif-decode.ts`, their tests and fixtures; `prepare-image.ts`; delete `heic-convert.d.ts`), `package.json`,
  `package-lock.json`, `knowledge/store/heif-preview.ts` and its test (comment and title), `docs/uploads.md`.
- **Slice B (document path), after A is committed:** `src/lib/server/services/extraction/*` (contracts, runner,
  reader input, both extractors, tests), `src/lib/server/services/mineru/heic.integration.test.ts`,
  `src/lib/shared/extraction-status.ts`, `src/lib/i18n/knowledge.ts`, `src/lib/i18n/chat.ts`,
  `src/routes/(app)/knowledge/_components/documents-table.ts`, `vision/AGENTS.md`, the build log.

Each slice: failing test first, small commits (one logical change each, the message says why), `npm run check` and
the touched tests while iterating. The whole gate runs once at the end, in the orchestrating session.

## As built

Where the build differs from the spec above, which stays as it was decided. Slice A is `b9f9fa574` to `bfa67c743`; Slice B
is every commit from `412c6f0fa` on (the code is `412c6f0fa`, `782fcd262`, `40a46e693` and `061261150`).

Slice A, the decoder:

- A5 waits one 30 ms tick after `monitorEventLoopDelay.enable()` before it starts the decode: a decode that blocks from the
  very instant of `enable()` records no lag at all, so the test would pass against the main-thread decode it must fail
  against.
- The input is copied with `new Uint8Array(input)`, not `input.slice()`: a Buffer's `slice` is a view on the same memory, and
  the memory of a pooled Buffer cannot be transferred.
- A pool place is freed on the worker's `exit`, not when the job settles. A stopped worker still holds its heap until its
  thread is gone, and the cap of two is a cap on that.
- Only `ImageTooLargeError`, `ImageDecodeTimeoutError` and the abort reason pass out of `prepare-image.ts` as they are.
  Everything else is wrapped `image preparation failed: …`, which is what the existing tests assert.
- `readDecoderAnswer` is exported: it is the one check of the worker's reply (a picture over the cap, pixels that are not
  the size they claim), and a test drives it without a thread.
- A HEIC's PNG made without `background` carries a fully opaque alpha channel (`hasAlpha` is true), as a transparent PNG's
  does; only the reader, which asks for white, gets none.
- `heic-decode` is listed in Fallow's `ignoreDependencies`: only the worker loads it, by path, so no import names it.

Slice B, the document path:

- `prepareReaderInput` is synchronous (no I/O before `openFile`), and `reader-input.ts` has a second export,
  `storedReaderInput`, which the runner uses for a direct-text job (as before, only a MinerU job can be converted) and
  `prepareReaderInput` uses for a type the reader takes as it is. An `openFile` after `release` rejects for both, with a plain
  `Error` and not a `DocumentExtractionError`: it means the caller used the file after the attempt, which is no fact about the
  file.
- The reader looks at the attempt's signal before it reads anything and again when the decode returns, and once the signal is
  aborted it throws `signal.reason` whatever the decoder failed with, so a cancel is never reported as a bad photo. It passes
  the extractor's signal (the bridge's, whose reason is an `ExtractionAbortError`), not the engine's.
- The MinerU extractor memoizes its own ask for the file as well (one `request.openFile()` call per attempt, however many
  steps need the bytes), on top of the reader's memoization. It keeps `statFile` as the authority for the size a task
  declares ("what the file is NOW"); `ExtractionFile.sizeBytes` is read by the direct-text extractor only, as its fallback
  when the file cannot be measured. An abort at the digest step, which sits outside the recovery loop, is mapped to
  `canceled` there.
- The digest order of D8 changed no existing test: none held a resumed handle and a ledger digest that differ. The new test
  gives both and expects the handle's.
- `image_too_large`'s `details` are `{ reason, pixels, limit }` and a timeout's `{ reason, timeoutMs }`; the spec named the
  pixels and the limit only.
- An undecodable photo through the real extractor now costs one capability read: MinerU is asked what it can do (the answer
  is cached for `capabilitiesTtlMs`), and then no task is created. The old test claimed "MinerU is never asked"; that is
  the other side of D7, and the test says what is true now.
- B1 to B3 and B6 to B8 run through the real engine, the real MinerU extractor and the fake server
  (`mineru/heic.integration.test.ts`, which records the threads the pool starts with a subclass of `Worker`), and B3, B8 and
  the order of B2 have counterparts at the extractor (`mineru4.test.ts`). B4 and B5 are in `extraction-runner.test.ts`. B5's
  proof that the thread was stopped is a flag on the recording worker, set if it ever answers: a worker called off mid-decode
  ends without a word, whereas the exit code says nothing (the pool terminates a worker that has answered, too). The test
  cancels as soon as the recording worker's constructor reports the thread, so the cancel lands before the decode could
  finish however busy the machine is.
  B7 runs the attempt budget out as well: three tries end as `max_attempts`. The "100" of B10 is held in
  `extraction/contracts.test.ts`, which reads the ledger sentence and both Library sentences.
- `docs/uploads.md` belongs to Slice A and was edited again here: its sentence that an undecodable photo "fails at once as
  `document_unreadable`, with no request to MinerU" stopped being true with D7, and it now says when the decode happens and
  which ledger code each failure of it gets (D9).
- A photo's PNG is not byte for byte the one the previous release made (no JPEG step, flattened onto white), so a MinerU
  task that is still waiting for its bytes at the deploy is declared again once: the PUT with the new bytes is refused as a
  digest mismatch, and the extractor's existing recovery creates the task again.
