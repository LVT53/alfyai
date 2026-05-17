import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { ThinkingSegment } from '$lib/types';
import ThinkingBlock from './ThinkingBlock.svelte';

describe('ThinkingBlock', () => {
	it('hides file-production tool calls from the thinking surface', async () => {
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
		expect(screen.queryByText(/Fetching:/)).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: /Thought/i }));

		expect(screen.queryByText('produce_file')).not.toBeInTheDocument();
		expect(screen.queryByText(/Fetching:/)).not.toBeInTheDocument();
	});

	it('keeps real URL-fetch tools as Fetching links', () => {
		const segments: ThinkingSegment[] = [
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

		expect(screen.getByText('example.com')).toBeInTheDocument();
		expect(screen.getByText(/Fetching:/)).toBeInTheDocument();
	});

	it('renders comma-separated URL fetch inputs as separate Fetching links', () => {
		const segments: ThinkingSegment[] = [
			{
				type: 'tool_call',
				name: 'fetch_url',
				status: 'done',
				input: {
					url: 'https://a.example/x, https://b.example/y',
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

		const links = screen.getAllByRole('link', { name: /(?:a|b)\.example/ });

		expect(links).toHaveLength(2);
		expect(screen.getAllByText(/Fetching:/)).toHaveLength(2);
		expect(links[0]).toHaveAttribute('href', 'https://a.example/x');
		expect(links[1]).toHaveAttribute('href', 'https://b.example/y');
	});
});
