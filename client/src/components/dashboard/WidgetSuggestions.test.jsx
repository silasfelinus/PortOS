import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WidgetSuggestions from './WidgetSuggestions';

// `quick-stats` ships with gate: (s) => s.apps.length > 0 — a deterministic
// fixture lets us exercise the "data populated but widget missing" path
// without mocking the registry.

describe('WidgetSuggestions', () => {
  const emptyState = { apps: [], usage: null };
  const populatedState = {
    apps: [{ id: 'a1', name: 'app', overallStatus: 'online' }],
    usage: { currentStreak: 5, longestStreak: 5, hourlyActivity: [0, 0, 1, 0] },
  };

  it('renders nothing when every gated widget is already present', () => {
    const { container } = render(
      <WidgetSuggestions
        presentWidgetIds={['quick-stats', 'activity-streak', 'hourly-activity']}
        dashboardState={populatedState}
        onAdd={() => {}}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no gated widget has data', () => {
    const { container } = render(
      <WidgetSuggestions presentWidgetIds={[]} dashboardState={emptyState} onAdd={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('suggests a missing-but-data-populated widget', () => {
    render(<WidgetSuggestions presentWidgetIds={[]} dashboardState={populatedState} onAdd={() => {}} />);
    expect(screen.getByText(/Quick Stats/)).toBeDefined();
  });

  it('calls onAdd with just the widget id (no layout shape leakage)', () => {
    const onAdd = vi.fn().mockResolvedValue();
    render(<WidgetSuggestions presentWidgetIds={['cos']} dashboardState={populatedState} onAdd={onAdd} />);
    fireEvent.click(screen.getByLabelText('Add Quick Stats to layout'));
    expect(onAdd).toHaveBeenCalledWith('quick-stats');
  });

  it('dismissing a suggestion hides it for the lifetime of the mount', () => {
    render(<WidgetSuggestions presentWidgetIds={[]} dashboardState={populatedState} onAdd={() => {}} />);
    expect(screen.queryByText(/Quick Stats/)).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Dismiss Quick Stats suggestion'));
    expect(screen.queryByText(/Quick Stats/)).toBeNull();
  });

  it('swallows gate-predicate exceptions without surfacing the widget', () => {
    // Future widgets may add gate predicates that destructure partial state.
    const { container } = render(
      <WidgetSuggestions presentWidgetIds={[]} dashboardState={undefined} onAdd={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
