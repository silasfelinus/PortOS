import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import InsightCard from './InsightCard';

describe('InsightCard', () => {
  it('renders the title and children', () => {
    render(
      <InsightCard title="A theme">
        <p>narrative body</p>
      </InsightCard>,
    );
    expect(screen.getByRole('heading', { name: 'A theme' })).toBeTruthy();
    expect(screen.getByText('narrative body')).toBeTruthy();
  });

  it('renders no provenance chip when provenance is absent', () => {
    render(<InsightCard title="No prov" badge={<span>Strong</span>} />);
    expect(screen.queryByRole('button', { name: /tap for how this is derived/i })).toBeNull();
  });

  it('renders a provenance chip from the provenance prop and reveals override copy on click', () => {
    render(
      <InsightCard
        title="Inferred theme"
        provenance={{
          level: 'inferred',
          explainer: 'Modeled from your taste profile.',
          whatWouldChange: 'Answer more of the profile.',
        }}
      />,
    );
    const chip = screen.getByRole('button', { name: /inferred/i });
    expect(chip).toBeTruthy();
    expect(screen.queryByText('What would change this?')).toBeNull();

    fireEvent.click(chip);

    expect(screen.getByText('Modeled from your taste profile.')).toBeTruthy();
    expect(screen.getByText('Answer more of the profile.')).toBeTruthy();
  });

  it('renders both the provenance chip and the confidence badge together', () => {
    render(
      <InsightCard
        title="Both axes"
        provenance={{ level: 'inferred' }}
        badge={<span>Strong pattern</span>}
      />,
    );
    expect(screen.getByRole('button', { name: /inferred/i })).toBeTruthy();
    expect(screen.getByText('Strong pattern')).toBeTruthy();
  });
});
