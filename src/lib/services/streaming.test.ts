import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamCallbacks } from './streaming';
import { streamChat } from './streaming';

function buildFetchResponse(sseLines: string[], status = 200): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of sseLines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		}
	});
	return new Response(stream, {
		status,
		headers: { 'Content-Type': 'text/event-stream' }
	});
}

interface MockCallbacks {
	onToken: ReturnType<typeof vi.fn>;
	onThinking: ReturnType<typeof vi.fn>;
	onEnd: ReturnType<typeof vi.fn>;
	onError: ReturnType<typeof vi.fn>;
}

function makeCallbacks(): MockCallbacks {
	return {
		onToken: vi.fn(),
		onThinking: vi.fn(),
		onEnd: vi.fn(),
		onError: vi.fn()
	};
}

async function waitForStream(cb: MockCallbacks): Promise<void> {
	return new Promise<void>((resolve) => {
		const originalOnEnd = cb.onEnd as (...args: unknown[]) => void;
		const originalOnError = cb.onError as (...args: unknown[]) => void;
		cb.onEnd = vi.fn((...args: unknown[]) => {
			originalOnEnd(...args);
			resolve();
		});
		cb.onError = vi.fn((...args: unknown[]) => {
			originalOnError(...args);
			resolve();
		});
	});
}

describe('streamChat', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('calls onToken for each SSE token chunk', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: token\n',
				'data: {"text":"Hello"}\n',
				'\n',
				'event: token\n',
				'data: {"text":" world"}\n',
				'\n',
				'event: end\n',
				'data: {}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, 'Hello');
		expect(cb.onToken).toHaveBeenNthCalledWith(2, ' world');
	});

	it('calls onEnd with full concatenated text', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: token\n',
				'data: {"text":"Hello"}\n',
				'\n',
				'event: token\n',
				'data: {"text":" world"}\n',
				'\n',
				'event: end\n',
				'data: {}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledOnce();
		expect(cb.onEnd).toHaveBeenCalledWith('Hello world', undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it('calls onThinking for thinking SSE chunks', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: thinking\n',
				'data: {"text":"Need to reason first"}\n',
				'\n',
				'event: token\n',
				'data: {"text":"Final answer"}\n',
				'\n',
				'event: end\n',
				'data: {"thinking":"Need to reason first"}\n',
				'\n'
			])
		);

		const cb = {
			...makeCallbacks(),
			onThinking: vi.fn()
		};
		const done = waitForStream(cb as unknown as MockCallbacks);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith('Need to reason first');
		expect(cb.onEnd).toHaveBeenCalledWith('Final answer', {
			thinking: 'Need to reason first'
		});
	});

	it('routes inline <thinking> tags from token chunks into onThinking', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: token\n',
				'data: {"text":"Before<thinking>Need to reason</thinking>After"}\n',
				'\n',
				'event: end\n',
				'data: {}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, 'Before');
		expect(cb.onToken).toHaveBeenNthCalledWith(2, 'After');
		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith('Need to reason');
		expect(cb.onEnd).toHaveBeenCalledWith('BeforeAfter', undefined);
	});

	it('handles inline <thinking> tags split across token events', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: token\n',
				'data: {"text":"Start<th"}\n',
				'\n',
				'event: token\n',
				'data: {"text":"inking>Need"}\n',
				'\n',
				'event: token\n',
				'data: {"text":" to search</thin"}\n',
				'\n',
				'event: token\n',
				'data: {"text":"king>End"}\n',
				'\n',
				'event: end\n',
				'data: {}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, 'Start');
		expect(cb.onToken).toHaveBeenNthCalledWith(2, 'End');
		expect(cb.onThinking).toHaveBeenCalledTimes(2);
		expect(cb.onThinking).toHaveBeenNthCalledWith(1, 'Need');
		expect(cb.onThinking).toHaveBeenNthCalledWith(2, ' to search');
		expect(cb.onEnd).toHaveBeenCalledWith('StartEnd', undefined);
	});

	it('parses end-event metadata from the data line', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: token\n',
				'data: {"text":"Hello"}\n',
				'\n',
				'event: end\n',
				'data: {"thinkingTokenCount":2,"responseTokenCount":3,"totalTokenCount":5,"wasStopped":false,"modelDisplayName":"Model 1","contextSources":{"conversationId":"conv-1","userId":"user-1","activeCount":1,"inferredCount":0,"selectedCount":1,"pinnedCount":0,"excludedCount":0,"reduced":false,"compacted":false,"groups":[],"updatedAt":1777140000000}}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith('Hello', {
			thinkingTokenCount: 2,
			responseTokenCount: 3,
			totalTokenCount: 5,
			wasStopped: false,
			modelDisplayName: 'Model 1',
			contextSources: {
				conversationId: 'conv-1',
				userId: 'user-1',
				activeCount: 1,
				inferredCount: 0,
				selectedCount: 1,
				pinnedCount: 0,
				excludedCount: 0,
				reduced: false,
				compacted: false,
				groups: [],
				updatedAt: 1777140000000
			}
		});
	});

	it('parses trailing end-event metadata when the stream closes without a final blank line', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: token\n',
				'data: {"text":"Hello"}\n',
				'\n',
				'event: end\n',
				'data: {"assistantMessageId":"assistant-1","wasStopped":false}'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith('Hello', {
			assistantMessageId: 'assistant-1',
			wasStopped: false
		});
	});

	it('reports opt-in client timing without changing token parsing or logging by default', async () => {
		const mockFetch = vi.mocked(fetch);
		const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				': prelude\n',
				'\n',
				'event: token\n',
				'data: {"text":"Hello"}\n',
				'\n',
				'event: end\n',
				'data: {}\n',
				'\n'
			])
		);

		const cb = {
			...makeCallbacks(),
			onTiming: vi.fn(),
		};
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledWith('Hello');
		expect(cb.onEnd).toHaveBeenCalledWith('Hello', undefined);
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				url: '/api/chat/stream',
				streamId: expect.any(String),
				phases: expect.objectContaining({
					fetchStartMs: 0,
					responseHeadersMs: expect.any(Number),
					firstByteMs: expect.any(Number),
					firstTokenMs: expect.any(Number),
					endMs: expect.any(Number),
				}),
			})
		);
		expect(consoleInfo).not.toHaveBeenCalled();
		consoleInfo.mockRestore();
	});

	it('threads the active workspace document id into the streaming request body', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: end\n',
				'data: {}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks, {
			activeDocumentArtifactId: 'artifact-focused-1',
		});
		await done;

		expect(mockFetch).toHaveBeenCalledWith(
			'/api/chat/stream',
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: expect.any(String),
			})
		);
		const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
		const parsedBody = JSON.parse(String(requestInit?.body));
		expect(parsedBody.activeDocumentArtifactId).toBe('artifact-focused-1');
		expect(parsedBody.conversationId).toBe('conv-1');
	});

	it('threads the selected Deep Research depth into the streaming request body', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: end\n',
				'data: {}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('research this', 'conv-1', cb as unknown as StreamCallbacks, {
			deepResearchDepth: 'standard',
		});
		await done;

		const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
		const parsedBody = JSON.parse(String(requestInit?.body));
		expect(parsedBody.deepResearch).toEqual({ depth: 'standard' });
	});

	it('threads the active workspace document id into retry requests too', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: end\n',
				'data: {}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('ignored', 'conv-1', cb as unknown as StreamCallbacks, {
			retryAssistantMessageId: 'assistant-msg-1',
			retryUserMessageId: 'user-msg-1',
			retryUserMessage: 'historical user text',
			activeDocumentArtifactId: 'artifact-focused-2',
		});
		await done;

		expect(mockFetch).toHaveBeenCalledWith(
			'/api/chat/retry',
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: expect.any(String),
			})
		);
		const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
		const parsedBody = JSON.parse(String(requestInit?.body));
		expect(parsedBody.assistantMessageId).toBe('assistant-msg-1');
		expect(parsedBody.userMessageId).toBe('user-msg-1');
		expect(parsedBody.userMessage).toBe('historical user text');
		expect(parsedBody.activeDocumentArtifactId).toBe('artifact-focused-2');
	});

	it('threads confirmed forked source-history mutation into retry requests', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: end\n',
				'data: {}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('ignored', 'conv-1', cb as unknown as StreamCallbacks, {
			retryAssistantMessageId: 'assistant-msg-1',
			retryUserMessageId: 'user-msg-1',
			retryUserMessage: 'historical user text',
			confirmForkedSourceHistoryMutation: true,
		});
		await done;

		const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
		const parsedBody = JSON.parse(String(requestInit?.body));
		expect(parsedBody.confirmForkedSourceHistoryMutation).toBe(true);
	});

	it('parses tool-call details and assistant evidence metadata', async () => {
		const mockFetch = vi.mocked(fetch);
		const onToolCall = vi.fn();
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: tool_call\n',
				'data: {"name":"web_search","input":{"query":"OpenAI news"},"status":"done","outputSummary":"Found sources","sourceType":"web","candidates":[{"id":"src-1","title":"OpenAI","url":"https://openai.com","sourceType":"web"}]}\n',
				'\n',
				'event: token\n',
				'data: {"text":"Hello"}\n',
				'\n',
				'event: end\n',
				'data: {"messageEvidence":{"structuredWebSearch":true,"groups":[{"sourceType":"web","label":"Web Search","reranked":true,"confidence":88,"items":[{"id":"src-1","title":"OpenAI","sourceType":"web","status":"selected","url":"https://openai.com"}]}]}}\n',
				'\n'
			])
		);

		const cb = {
			...makeCallbacks(),
			onToolCall,
		};
		const done = waitForStream(cb as unknown as MockCallbacks);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(onToolCall).toHaveBeenCalledWith(
			'web_search',
			{ query: 'OpenAI news' },
			'done',
			{
				outputSummary: 'Found sources',
				sourceType: 'web',
				candidates: [
					{
						id: 'src-1',
						title: 'OpenAI',
						url: 'https://openai.com',
						sourceType: 'web',
					},
				],
			}
		);
		expect(cb.onEnd).toHaveBeenCalledWith('Hello', {
			messageEvidence: {
				structuredWebSearch: true,
				groups: [
					{
						sourceType: 'web',
						label: 'Web Search',
						reranked: true,
						confidence: 88,
						items: [
							{
								id: 'src-1',
								title: 'OpenAI',
								sourceType: 'web',
								status: 'selected',
								url: 'https://openai.com',
							},
						],
					},
				],
			},
		});
	});

	it('calls onError on network failure', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockRejectedValue(new Error('Network failure'));

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Network failure' }));
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it('calls onError when response is not ok', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: 'Unauthorized' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unauthorized' }));
	});

	it('calls onError when stream emits error event', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: error\n',
				'data: {"message":"Something went wrong"}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Something went wrong' })
		);
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it('calls onEnd with accumulated text when stream closes without end event', async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				'event: token\n',
				'data: {"text":"partial"}\n',
				'\n'
			])
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledOnce();
		expect(cb.onEnd).toHaveBeenCalledWith('partial');
	});

	it('stop() requests a server stop and does not call onError', async () => {
		const mockFetch = vi.mocked(fetch);

		let abortReject!: (err: Error) => void;
		mockFetch.mockImplementation((input) => {
			if (typeof input === 'string' && input === '/api/chat/stream/stop') {
				return Promise.resolve(
					new Response(JSON.stringify({ stopped: true }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			}

			return new Promise<Response>((_resolve, reject) => {
				abortReject = reject;
			});
		});

		const cb = makeCallbacks();
		const handle = streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);

		await new Promise((r) => setTimeout(r, 10));
		handle.stop();

		abortReject(new DOMException('The user aborted a request.', 'AbortError'));

		await new Promise((r) => setTimeout(r, 30));

		expect(cb.onError).not.toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(mockFetch).toHaveBeenNthCalledWith(
			2,
			'/api/chat/stream/stop',
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			})
		);
		const streamRequest = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
		const stopRequest = mockFetch.mock.calls[1]?.[1] as RequestInit | undefined;
		expect(streamRequest?.body).toEqual(expect.any(String));
		expect(stopRequest?.body).toEqual(expect.any(String));
		expect(JSON.parse(String(stopRequest?.body)).streamId).toBe(
			JSON.parse(String(streamRequest?.body)).streamId
		);
	});

	it('detach() aborts the local stream without requesting a server stop or emitting stop metadata', async () => {
		const mockFetch = vi.mocked(fetch);

		let abortReject!: (err: Error) => void;
		mockFetch.mockImplementation(() =>
			new Promise<Response>((_resolve, reject) => {
				abortReject = reject;
			})
		);

		const cb = makeCallbacks();
		const handle = streamChat('test message', 'conv-1', cb as unknown as StreamCallbacks);

		await new Promise((r) => setTimeout(r, 10));
		handle.detach();

		abortReject(new DOMException('The user aborted a request.', 'AbortError'));

		await new Promise((r) => setTimeout(r, 30));

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onError).not.toHaveBeenCalled();
	});
});
