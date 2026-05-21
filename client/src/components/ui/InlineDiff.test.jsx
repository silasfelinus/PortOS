import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import InlineDiff from './InlineDiff';

describe('InlineDiff', () => {
  it('shows the empty-label when the two texts are identical', () => {
    render(<InlineDiff oldText="Hello world" newText="Hello world" />);
    expect(screen.getByText('No changes.')).toBeInTheDocument();
  });

  it('shows a custom empty-label when supplied', () => {
    render(<InlineDiff oldText="" newText="" emptyLabel="(blank on both sides)" />);
    expect(screen.getByText('(blank on both sides)')).toBeInTheDocument();
  });

  it('renders both stacked rows when the texts differ', () => {
    const { container } = render(<InlineDiff oldText="The cat sat" newText="The dog sat" />);
    expect(screen.queryByText('No changes.')).not.toBeInTheDocument();
    // Two stacked diff rows — the red (removed) and green (added) divs.
    expect(container.querySelectorAll('.text-red-400')).toHaveLength(1);
    expect(container.querySelectorAll('.text-green-400')).toHaveLength(1);
  });

  it('highlights only the changed words inside each row, not the unchanged ones', () => {
    const { container } = render(<InlineDiff oldText="The cat sat" newText="The dog sat" />);
    // Removed-word span lives inside the red row.
    const removedSpans = container.querySelectorAll('.text-red-400 .bg-red-900\\/50');
    const addedSpans = container.querySelectorAll('.text-green-400 .bg-green-900\\/50');
    expect(removedSpans).toHaveLength(1);
    expect(addedSpans).toHaveLength(1);
    expect(removedSpans[0].textContent).toBe('cat');
    expect(addedSpans[0].textContent).toBe('dog');
  });

  it('tolerates null/undefined inputs by treating them as empty strings', () => {
    render(<InlineDiff oldText={null} newText={undefined} />);
    expect(screen.getByText('No changes.')).toBeInTheDocument();
  });

  it('bails to plain side-by-side render when either side exceeds the token cap', () => {
    // Build a string with way more than DIFF_TOKEN_CAP (8000) tokens.
    const huge = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(' '); // 5000 words → ~10K tokens after split on whitespace
    const { container } = render(<InlineDiff oldText={huge} newText="short" />);
    expect(screen.getByText(/Diff too large/i)).toBeInTheDocument();
    // No per-word highlight spans — just the two flat color blocks.
    expect(container.querySelectorAll('.bg-red-900\\/50, .bg-green-900\\/50')).toHaveLength(0);
  });
});
