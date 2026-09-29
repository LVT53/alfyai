// Board fixtures shared by the Canvas suites (body model, ops vocabulary, the
// ops envelope and its route). A test helper, never imported by app code.
import type { CanvasBody } from "./canvas";

/**
 * A canonical board that uses every block kind, a frame with a child, an edge,
 * a camera and one annotation of each family. Already in canonical form, so a
 * round trip through `normalizeCanvasBody` and `boardJson` must leave it alone.
 */
export function sampleBoard(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "frame-a",
				type: "frame",
				position: { x: 40, y: 40 },
				width: 360,
				height: 300,
				data: { kind: "frame", label: "Saturday", width: 360, height: 300 },
			},
			{
				id: "note-1",
				type: "sticky",
				parentId: "frame-a",
				position: { x: 20, y: 60 },
				width: 190,
				height: 84,
				data: { kind: "sticky", text: "Lunch at the market", tone: "yellow" },
			},
			{
				id: "note-museum",
				type: "sticky",
				position: { x: 500, y: 60 },
				data: { kind: "sticky", text: "Museum, 14:00", tone: "mint" },
			},
			{
				id: "text-1",
				type: "text",
				position: { x: 500, y: 200 },
				data: { kind: "text", text: "Weekend plan" },
			},
			{
				id: "todo-1",
				type: "checklist",
				position: { x: 500, y: 260 },
				data: {
					kind: "checklist",
					label: "Pack",
					items: [
						{ id: "i1", text: "Passport", done: true },
						{ id: "i2", text: "Charger", done: false },
					],
				},
			},
			{
				id: "chart-1",
				type: "chart",
				position: { x: 40, y: 400 },
				data: {
					kind: "chart",
					label: "Budget",
					code: '{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}',
				},
			},
			{
				id: "map-1",
				type: "map",
				position: { x: 300, y: 400 },
				data: {
					kind: "map",
					route: "Vienna to Salzburg",
					meta: "3 h",
					map: {
						bounds: { minLat: 47.8, minLng: 13, maxLat: 48.2, maxLng: 16.4 },
						polyline: [
							[48.2, 16.4],
							[47.8, 13],
						],
						attribution: "OpenStreetMap",
					},
				},
			},
			{
				id: "file-1",
				type: "file",
				position: { x: 600, y: 400 },
				data: {
					kind: "file",
					fileId: "chat-file-1",
					name: "Trip.pdf",
					mime: "application/pdf",
					bytes: 1234,
					label: "PDF",
				},
			},
			{
				id: "app-1",
				type: "app",
				position: { x: 40, y: 700 },
				data: { kind: "app", artifactId: "artifact-app-1", title: "Budget" },
			},
			{
				id: "photo-1",
				type: "photo",
				position: { x: 300, y: 700 },
				data: {
					kind: "photo",
					items: [
						{
							id: "p1",
							imageUrl:
								"/api/connections/immich/thumbnail/asset-1?connectionId=c1",
						},
					],
				},
			},
			{
				id: "web-1",
				type: "liveweb",
				position: { x: 600, y: 700 },
				data: {
					kind: "liveweb",
					query: "weather in Salzburg",
					sources: [
						{
							id: "s1",
							title: "Forecast",
							url: "https://example.com/forecast",
							provider: "parallel",
							authorityClass: "primary",
							authorityScore: 0.9,
							publishedAt: null,
							updatedAt: null,
						},
					],
					fetchedAt: 1_700_000_000_000,
				},
			},
		],
		edges: [
			{ id: "edge-1", source: "note-1", target: "text-1", label: "then" },
		],
		viewport: { x: -20, y: 10, zoom: 0.8 },
		annotations: [
			{
				id: "ann-pen",
				kind: "pen",
				color: "#2f6fd0",
				size: 3,
				points: [
					{ x: 1, y: 2 },
					{ x: 3, y: 4 },
				],
			},
			{
				id: "ann-arrow",
				kind: "arrow",
				color: "#c0392b",
				size: 2,
				from: { x: 0, y: 0 },
				to: { x: 10, y: 10 },
			},
			{
				id: "ann-text",
				kind: "text",
				color: "#59636e",
				size: 14,
				at: { x: 5, y: 5 },
				text: "hi",
			},
		],
	};
}

/** A deep copy no test can mutate the shared fixture through. */
export function cloneBoard<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
