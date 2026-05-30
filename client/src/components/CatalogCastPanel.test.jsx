import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/apiCatalog', () => ({
  listCatalogIngredientsForRef: vi.fn(),
  linkCatalogIngredient: vi.fn(),
  unlinkCatalogIngredient: vi.fn(),
  listCatalogIngredients: vi.fn(),
}));

vi.mock('./ui/Toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import CatalogCastPanel from './CatalogCastPanel';
import {
  listCatalogIngredientsForRef,
  linkCatalogIngredient,
  unlinkCatalogIngredient,
  listCatalogIngredients,
} from '../services/apiCatalog';

const renderPanel = (props = {}) => render(
  <MemoryRouter>
    <CatalogCastPanel refKind="series" refId="series-1" {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  listCatalogIngredients.mockResolvedValue({ items: [] });
});

describe('CatalogCastPanel', () => {
  it('renders the empty state when no ingredients are linked', async () => {
    listCatalogIngredientsForRef.mockResolvedValue([]);
    renderPanel({ refLabel: 'Test Series' });
    await waitFor(() => {
      expect(screen.getByText(/No catalog ingredients linked yet/i)).toBeTruthy();
    });
    expect(screen.getByText(/for Test Series/i)).toBeTruthy();
  });

  it('renders rows from the fetched list', async () => {
    listCatalogIngredientsForRef.mockResolvedValue([
      {
        ingredient: {
          id: 'i-1',
          name: 'Ada Lovelace',
          type: 'character',
          payload: { description: 'Mathematician, programmer, dreamer.' },
        },
        role: 'cast-character',
      },
      {
        ingredient: {
          id: 'i-2',
          name: 'Babbage Hall',
          type: 'place',
          payload: { description: 'A drafty workshop full of brass.' },
        },
        role: 'cast-place',
      },
    ]);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    });
    expect(screen.getByText('Babbage Hall')).toBeTruthy();
    expect(screen.getByText(/Mathematician, programmer/i)).toBeTruthy();
  });

  it('opens the picker when Add is clicked', async () => {
    listCatalogIngredientsForRef.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/No catalog ingredients linked yet/i)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Add from Catalog/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Pick an ingredient/i })).toBeTruthy();
    });
  });

  it('removes a row locally after unlink succeeds', async () => {
    listCatalogIngredientsForRef.mockResolvedValue([
      {
        ingredient: { id: 'i-1', name: 'Ada Lovelace', type: 'character', payload: {} },
        role: 'cast-character',
      },
      {
        ingredient: { id: 'i-2', name: 'Babbage Hall', type: 'place', payload: {} },
        role: 'cast-place',
      },
    ]);
    unlinkCatalogIngredient.mockResolvedValue(undefined);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    });

    const removeBtn = screen.getByLabelText(/Unlink Ada Lovelace/i);
    await act(async () => {
      fireEvent.click(removeBtn);
    });

    await waitFor(() => {
      expect(screen.queryByText('Ada Lovelace')).toBeNull();
    });
    expect(screen.getByText('Babbage Hall')).toBeTruthy();
    expect(unlinkCatalogIngredient).toHaveBeenCalledWith(
      'i-1',
      { refKind: 'series', refId: 'series-1', role: 'cast-character' },
      { silent: true },
    );
    expect(linkCatalogIngredient).not.toHaveBeenCalled();
  });
});
