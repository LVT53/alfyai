import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { ThinkingSegment } from '$lib/types';
import ThinkingBlock from './ThinkingBlock.svelte';

describe('ThinkingBlock', () => {
	it('does not render a completed Thought disclosure for hidden tool-only activity', () => {
		const segments: ThinkingSegment[] = [
			{
				type: 'tool_call',
				name: 'produce_file',
				status: 'done',
				input: {
					requestTitle: 'Quarterly report',
					previewUrl: 'https://example.com/report.pdf',
				},
			},
		];

		render(ThinkingBlock, {
			props: {
				content: '',
				thinkingIsDone: true,
				segments,
			},
		});

		expect(screen.queryByText('produce_file')).not.toBeInTheDocument();
		expect(screen.queryByText(/Fetch page:/)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Thought/i })).not.toBeInTheDocument();
	});

	it('keeps completed tool activity inside completed Thought at the original trace position', async () => {
		const segments: ThinkingSegment[] = [
			{ type: 'text', content: 'I checked the relevant source.' },
			{
				type: 'tool_call',
				name: 'fetch_url',
				status: 'done',
				input: {
					url: 'https://example.com/article',
				},
			},
		];

		render(ThinkingBlock, {
			props: {
				content: '',
				thinkingIsDone: true,
				segments,
			},
		});

		expect(screen.getByRole('button', { name: /Thought/ })).toBeInTheDocument();

		expect(screen.queryByText(/Thinking trace saved|Thought available/i)).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: /Thought/ }));

		expect(screen.getByText('I checked the relevant source.')).toBeInTheDocument();
		const links = screen.getAllByRole('link', { name: 'example.com' });
		expect(links.length).toBeGreaterThan(0);
		expect(links[0]).toHaveAttribute(
			'href',
			'https://example.com/article',
		);
	});

	it('separates interim thought snippets for display without changing the raw trace', async () => {
		const rawTrace = 'gonna search the Web.I am digging deeper.';

		render(ThinkingBlock, {
			props: {
				content: rawTrace,
				thinkingIsDone: true,
			},
		});

		await fireEvent.click(screen.getByRole('button', { name: /Thought/ }));

		const thoughtText = screen.getByText(/gonna search the Web\.\s+I am digging deeper\./);
		expect(thoughtText.textContent).toContain('gonna search the Web.\n\nI am digging deeper.');
		expect(thoughtText.textContent).not.toContain(rawTrace);
		expect(rawTrace).toBe('gonna search the Web.I am digging deeper.');
	});

	it('separates active interim snippets when fresh text starts after punctuation', async () => {
		const rawTrace = 'gonna search the Web.I am digging deeper.';

		const { rerender } = render(ThinkingBlock, {
			props: {
				content: 'gonna search the Web.',
				thinkingIsDone: false,
			},
		});

		await fireEvent.click(screen.getByRole('button', { name: /Thinking/ }));
		await rerender({
			content: rawTrace,
			thinkingIsDone: false,
		});

		const freshText = screen.getByText('I am digging deeper.');
		const thoughtText = freshText.closest('pre');
		expect(thoughtText?.textContent).toContain('gonna search the Web.\n\nI am digging deeper.');
		expect(thoughtText?.textContent).not.toContain(rawTrace);
		expect(rawTrace).toBe('gonna search the Web.I am digging deeper.');
	});

	it('groups active comma-separated URL fetch inputs behind one fetched-sites disclosure', async () => {
		const segments: ThinkingSegment[] = [
			{
				type: 'tool_call',
				name: 'fetch_url',
				status: 'running',
				input: {
					url: 'https://a.example/x, https://b.example/y',
				},
			},
		];

		render(ThinkingBlock, {
			props: {
				content: '',
				thinkingIsDone: false,
				segments,
			},
		});

		expect(screen.getByRole('button', { name: /Thinking/ })).toBeInTheDocument();
		expect(screen.getByText('Fetched: 2 sites')).toBeInTheDocument();

		await fireEvent.click(screen.getByText('Fetched: 2 sites'));
		const links = screen.getAllByRole('link', { name: /(?:a|b)\.example/ });
		expect(links).toHaveLength(2);
		expect(links[0]).toHaveAttribute('href', 'https://a.example/x');
		expect(links[1]).toHaveAttribute('href', 'https://b.example/y');
		expect(document.querySelectorAll('.fetched-favicon')).toHaveLength(2);
	});

	it('summarizes web search tool calls without expanding every source diagnostic', async () => {
		const segments: ThinkingSegment[] = [
			{
				type: 'tool_call',
				name: 'research_web',
				status: 'running',
				input: {
					query: 'latest pricing',
				},
				sourceType: 'web',
				candidates: [
					{
						id: 'source-1',
						title: 'Widget Pro Store Page',
						url: 'https://shop.example.com/products/widget-pro',
						sourceType: 'web',
						material: true,
					},
				],
			},
		];

		render(ThinkingBlock, {
			props: {
				content: '',
				thinkingIsDone: false,
				segments,
			},
		});

		expect(screen.getByRole('button', { name: /Thinking/ })).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: /Thinking/ }));
		expect(screen.getAllByText('Fetched: 1 site')).toHaveLength(2);
		const [firstFetchedSummary] = screen.getAllByText('Fetched: 1 site');
		if (!firstFetchedSummary) throw new Error('Missing fetched source summary');
		await fireEvent.click(firstFetchedSummary);
		expect(
			screen.getAllByRole('link', { name: 'Widget Pro Store Page' }).length,
		).toBeGreaterThan(0);
		expect(document.querySelectorAll('.fetched-favicon').length).toBeGreaterThan(0);
		expect(screen.queryByText('Searching: "latest pricing"')).not.toBeInTheDocument();
	});

	it('uses different icons per deliberation pass', async () => {
		const segments: ThinkingSegment[] = [
			{
				type: 'status',
				id: 'deliberation-pass-1',
				status: 'done',
				label: 'Reviewing context and sources',
			},
			{
				type: 'status',
				id: 'deliberation-pass-2',
				status: 'done',
				label: 'Deepening source synthesis',
			},
			{
				type: 'status',
				id: 'deliberation-pass-3',
				status: 'done',
				label: 'Finalizing robust answer',
			},
		];

		const { container } = render(ThinkingBlock, {
			props: {
				content: '',
				thinkingIsDone: true,
				segments,
			},
		});

		await fireEvent.click(screen.getByRole('button', { name: /Thought/ }));

		const statusRows = container.querySelectorAll('.status-step');
		expect(statusRows).toHaveLength(3);
		expect(statusRows[0]?.querySelector('[data-deliberation-icon="search"]')).not.toBeNull();
		expect(statusRows[1]?.querySelector('[data-deliberation-icon="file"]')).not.toBeNull();
		expect(statusRows[2]?.querySelector('[data-deliberation-icon="check"]')).not.toBeNull();
	});

	it('renders deliberation status rows with the deliberation icon instead of a check icon', async () => {
		const segments: ThinkingSegment[] = [
			{
				type: 'status',
				id: 'deliberation-pass-1',
				status: 'done',
				label: 'Reviewed context and sources',
			},
			{
				type: 'text',
				content: 'Checked evidence and draft plan.',
			},
		];

		render(ThinkingBlock, {
			props: {
				content: '',
				thinkingIsDone: true,
				segments,
			},
		});

		expect(screen.getByRole('button', { name: /Thought/ })).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: /Thought/ }));
		await waitFor(() =>
			expect(screen.getByText('Reviewed context and sources')).toBeInTheDocument(),
		);

		const statusRow = screen
			.getByText('Reviewed context and sources')
			.closest('.status-step');
		expect(statusRow).not.toBeNull();
		expect(statusRow?.querySelector('.check-icon')).toBeNull();
		expect(statusRow?.querySelector('.deliberation-status-icon')).not.toBeNull();
	});

	it('shows only the latest deliberation status step while streaming', async () => {
		const { rerender } = render(ThinkingBlock, {
			props: {
				content: '',
				thinkingIsDone: false,
				streaming: true,
				segments: [
					{
						type: 'status',
						id: 'deliberation-pass-1',
						status: 'done',
						label: 'Reviewed context and sources',
					},
					{
						type: 'status',
						id: 'deliberation-pass-2',
						status: 'running',
						label: 'Checking answer plan',
					},
				],
			},
		});

		await fireEvent.click(screen.getByRole('button', { name: /Thinking/ }));

		expect(screen.getByText('Checking answer plan')).toBeInTheDocument();
		expect(screen.queryByText('Reviewed context and sources')).not.toBeInTheDocument();

		await rerender({
			content: '',
			thinkingIsDone: true,
			streaming: false,
			segments: [
				{
					type: 'status',
					id: 'deliberation-pass-1',
					status: 'done',
					label: 'Reviewed context and sources',
				},
				{
					type: 'status',
					id: 'deliberation-pass-2',
					status: 'done',
					label: 'Checking answer plan',
				},
			],
		});
		expect(screen.getByText('Reviewed context and sources')).toBeInTheDocument();
		expect(screen.getByText('Checking answer plan')).toBeInTheDocument();
	});

	it('shows fetched web source titles from research tool candidates', async () => {
		const segments: ThinkingSegment[] = [
			{
				type: 'tool_call',
				name: 'research_web',
				status: 'done',
				input: {
					query: 'latest pricing',
				},
				sourceType: 'web',
				candidates: [
					{
						id: 'source-1',
						title: 'Widget Pro Store Page',
						url: 'https://shop.example.com/products/widget-pro',
						sourceType: 'web',
						material: true,
					},
				],
			},
		];

		render(ThinkingBlock, {
			props: {
				content: '',
				thinkingIsDone: true,
				segments,
			},
		});

		await fireEvent.click(screen.getByRole('button', { name: /Thought/ }));

		expect(screen.getAllByText('Fetched: 1 site').length).toBeGreaterThan(0);
		const [firstFetchedSummary] = screen.getAllByText('Fetched: 1 site');
		if (!firstFetchedSummary) throw new Error('Missing fetched source summary');
		await fireEvent.click(firstFetchedSummary);
		const links = screen.getAllByRole('link', { name: 'Widget Pro Store Page' });
		expect(links.length).toBeGreaterThan(0);
		const [link] = links;
		if (!link) throw new Error('Missing fetched source link');
		expect(link).toHaveAttribute(
			'href',
			'https://shop.example.com/products/widget-pro',
		);
		expect(document.querySelectorAll('.fetched-favicon').length).toBeGreaterThan(0);
		expect(
			screen.queryByText('Searching: "latest pricing"'),
		).not.toBeInTheDocument();
	});
});
