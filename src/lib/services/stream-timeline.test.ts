import { describe, expect, it } from "vitest";
import {
	BROWSER_STREAM_TIMING_MARKS,
	type BrowserStreamTimingMark,
	type BrowserStreamTimingRecord,
	CONTEXT_PREPARATION_SLOW_STAGE_BUDGET_MS,
	classifyContextPreparationSlowStageTimings,
	createContextPreparationStageTimelineMark,
	createFallbackResponseActivityId,
	createTerminalStreamTimelinePayload,
	formatServerTimingHeader,
	normalizeStreamTimelineDurationMs,
	normalizeStreamTimelineTimings,
	parseServerTimingHeader,
	RESPONSE_ACTIVITY_IDS,
	type ResponseActivityId,
	recordContextPreparationTimelineTimings,
	recordDurationStreamTimelineMark,
	recordElapsedStreamTimelineMark,
	SERVER_STREAM_TIMELINE_MARKS,
	type ServerStreamTimelineMark,
	STREAM_TIMELINE_PAYLOAD_VERSION,
	type StreamTimelineTerminalPayload,
} from "./stream-timeline";

describe("stream timeline vocabulary", () => {
	it("owns the server, browser, and response activity vocabulary", () => {
		expect(SERVER_STREAM_TIMELINE_MARKS).toMatchObject({
			ROUTE_PARSE: "route_parse",
			CAPACITY: "capacity",
			ADMISSION: "admission",
			PRELUDE: "prelude",
			TURN_PREPARATION: "turn_preparation",
			DEPTH_SELECTION: "depth_selection",
			MODEL_STREAM_REQUEST: "model_stream_request",
			FIRST_UPSTREAM_EVENT: "first_upstream_event",
			FIRST_THINKING: "first_thinking",
			FIRST_VISIBLE_TOKEN: "first_visible_token",
			END: "end",
		});
		expect(BROWSER_STREAM_TIMING_MARKS).toMatchObject({
			FETCH_START: "fetchStartMs",
			RESPONSE_HEADERS: "responseHeadersMs",
			FIRST_BYTE: "firstByteMs",
			FIRST_RESPONSE_ACTIVITY: "firstActivityMs",
			FIRST_THINKING: "firstThinkingMs",
			FIRST_TOOL_CALL: "firstToolCallMs",
			FIRST_TOKEN: "firstTokenMs",
			END: "endMs",
			STOP: "stopMs",
			ERROR: "errorMs",
		});
		expect(RESPONSE_ACTIVITY_IDS).toMatchObject({
			DEPTH_SELECTED: "depth-selected",
			CONTEXT_PREPARING: "context-preparing",
			CONTEXT_READY: "context-ready",
			DRAFTING_ANSWER: "drafting-answer",
		});
		expect(createFallbackResponseActivityId("stream_connect_failure", 2)).toBe(
			"fallback:stream_connect_failure:2",
		);
		expect(createContextPreparationStageTimelineMark("prompt_budget")).toBe(
			"context_preparation_primary_prompt_budget",
		);
		expect(
			createContextPreparationStageTimelineMark("prompt_budget", {
				type: "fallback",
				attempt: 2,
			}),
		).toBe("context_preparation_fallback_2_prompt_budget");
		expect(STREAM_TIMELINE_PAYLOAD_VERSION).toBe(1);
	});

	it("exports serializable types for server and browser callers", () => {
		const serverMark: ServerStreamTimelineMark =
			SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN;
		const browserMark: BrowserStreamTimingMark =
			BROWSER_STREAM_TIMING_MARKS.FIRST_RESPONSE_ACTIVITY;
		const activityId: ResponseActivityId = createFallbackResponseActivityId(
			"stream_read_failure",
			1,
		);
		const browserTiming: BrowserStreamTimingRecord = {
			fetchStartMs: 0,
			responseHeadersMs: 8,
			firstActivityMs: 13,
		};
		const terminalPayload: StreamTimelineTerminalPayload =
			createTerminalStreamTimelinePayload({
				[serverMark]: 31,
			});

		expect({
			serverMark,
			browserMark,
			activityId,
			browserTiming,
			terminalPayload,
		}).toEqual({
			serverMark: "first_visible_token",
			browserMark: "firstActivityMs",
			activityId: "fallback:stream_read_failure:1",
			browserTiming: {
				fetchStartMs: 0,
				responseHeadersMs: 8,
				firstActivityMs: 13,
			},
			terminalPayload: {
				version: 1,
				server: {
					first_visible_token: 31,
				},
			},
		});
	});

	it("records elapsed marks once", () => {
		const timings = {};

		expect(
			recordElapsedStreamTimelineMark(
				timings,
				SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT,
				1_000,
				1_125.5,
			),
		).toBe(true);
		expect(
			recordElapsedStreamTimelineMark(
				timings,
				SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT,
				1_000,
				1_400,
			),
		).toBe(false);

		expect(timings).toEqual({ first_upstream_event: 125.5 });
	});

	it("records duration marks once", () => {
		const timings = {};

		expect(
			recordDurationStreamTimelineMark(
				timings,
				SERVER_STREAM_TIMELINE_MARKS.MODEL_STREAM_REQUEST,
				347.25,
			),
		).toBe(true);
		expect(
			recordDurationStreamTimelineMark(
				timings,
				SERVER_STREAM_TIMELINE_MARKS.MODEL_STREAM_REQUEST,
				999,
			),
		).toBe(false);

		expect(timings).toEqual({ model_stream_request: 347.25 });
	});

	it("normalizes finite non-negative durations", () => {
		expect(normalizeStreamTimelineDurationMs(0)).toBe(0);
		expect(normalizeStreamTimelineDurationMs(12.5)).toBe(12.5);
		expect(normalizeStreamTimelineDurationMs("42.25")).toBe(42.25);
		expect(normalizeStreamTimelineDurationMs(-1)).toBeUndefined();
		expect(
			normalizeStreamTimelineDurationMs(Number.POSITIVE_INFINITY),
		).toBeUndefined();
		expect(normalizeStreamTimelineDurationMs("")).toBeUndefined();
		expect(
			normalizeStreamTimelineTimings({
				valid_number: 12,
				valid_string: "7.5",
				invalid_negative: -1,
				invalid_text: "soon",
			}),
		).toEqual({
			valid_number: 12,
			valid_string: 7.5,
		});
	});

	it("formats Server-Timing with the current route timing header shape", () => {
		expect(
			formatServerTimingHeader({
				route_parse: 1,
				capacity: 2.06,
				admission: 0,
				turn_preparation: 4.44,
				invalid_negative: -1,
				invalid_infinite: Number.POSITIVE_INFINITY,
			}),
		).toBe(
			"route_parse;dur=1.0, capacity;dur=2.1, admission;dur=0.0, turn_preparation;dur=4.4",
		);
	});

	it("parses Server-Timing and keeps only finite non-negative durations", () => {
		expect(
			parseServerTimingHeader(
				'route_parse;dur=1.0, capacity;dur=-2, admission;desc="ok";dur=3.5, turn_preparation;dur=4.4, bad;dur=NaN, missing, empty;dur=, after_desc;desc="a,b";dur=5',
			),
		).toEqual({
			route_parse: 1,
			admission: 3.5,
			turn_preparation: 4.4,
			after_desc: 5,
		});
	});

	it("serializes a terminal server timeline payload", () => {
		const payload = createTerminalStreamTimelinePayload({
			route_parse: 1,
			model_stream_request: 200.125,
			invalid_negative: -4,
			invalid_nan: Number.NaN,
		});

		expect(payload).toEqual({
			version: 1,
			server: {
				route_parse: 1,
				model_stream_request: 200.125,
			},
		});
		expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
	});

	it("records completed context-preparation timings under scoped timeline marks", () => {
		const timings = {
			context_preparation_primary_plan: 999,
		};

		recordContextPreparationTimelineTimings(timings, [
			{
				stageId: "plan",
				durationMs: 12,
			},
			{
				stageId: "constructed_context",
				durationMs: "23.5",
			},
			{
				stageId: "prompt_budget",
				status: "started",
			},
			{
				stageId: "forced web prefetch",
				durationMs: 4,
			},
			{
				stageId: "invalid",
				durationMs: -1,
			},
		]);
		recordContextPreparationTimelineTimings(
			timings,
			[
				{
					stageId: "plan",
					durationMs: 5,
				},
			],
			{ type: "fallback", attempt: 2 },
		);

		expect(timings).toEqual({
			context_preparation_primary_plan: 999,
			context_preparation_primary_constructed_context: 23.5,
			context_preparation_primary_forced_web_prefetch: 4,
			context_preparation_fallback_2_plan: 5,
		});
	});

	it("classifies over-budget context-preparation timing records deterministically", () => {
		const webGroundingBudgetMs =
			CONTEXT_PREPARATION_SLOW_STAGE_BUDGET_MS["web-grounding"];
		const budgetingBudgetMs =
			CONTEXT_PREPARATION_SLOW_STAGE_BUDGET_MS.budgeting;

		const diagnostics = classifyContextPreparationSlowStageTimings(
			[
				{
					stageId: "prompt_budget",
					activityClass: "budgeting",
					durationMs: budgetingBudgetMs,
				},
				{
					stageId: "forced web prefetch",
					activityClass: "web-grounding",
					durationMs: webGroundingBudgetMs + 25,
				},
				{
					stageId: "constructed_context",
					activityClass: "context-retrieval",
					durationMs: -1,
				},
				{
					stageId: "api key leak attempt",
					activityClass: "provider-name-or-user-text" as never,
					durationMs: Number.MAX_SAFE_INTEGER,
				},
			],
			{ type: "fallback", attempt: 2 },
		);

		expect(diagnostics).toEqual([
			{
				activityClass: "web-grounding",
				stageId: "forced web prefetch",
				timingMark: "context_preparation_fallback_2_forced_web_prefetch",
				diagnosticKey:
					"web-grounding:context_preparation_fallback_2_forced_web_prefetch",
				durationMs: webGroundingBudgetMs + 25,
				budgetMs: webGroundingBudgetMs,
				overByMs: 25,
			},
		]);
	});
});
