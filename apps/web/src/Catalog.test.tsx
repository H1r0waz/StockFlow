import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Catalog } from './Catalog';

const category = {
  id: 'category-1',
  name: 'Materials',
  description: null,
  active: true,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const props = {
  organizationId: 'org-1',
  csrfToken: 'test-csrf',
  onExpired: vi.fn(),
};
afterEach(() => vi.unstubAllGlobals());

describe('catalog UI with mocked HTTP (not PostgreSQL verification)', () => {
  it('shows records but hides all mutation controls for a member', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ categories: [category] })),
    );
    render(<Catalog {...props} kind="categories" canEdit={false} />);
    expect(
      await screen.findByRole('cell', { name: 'Materials' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Read-only access/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /New|Edit|Activate|Deactivate/ }),
    ).not.toBeInTheDocument();
  });

  it('creates then edits a category with the organization URL and CSRF header', async () => {
    let current = { ...category };
    const fetchMock = vi
      .fn()
      .mockImplementation((_path: string, options: RequestInit) => {
        if (options.method) {
          current = { ...current, ...JSON.parse(String(options.body)) };
          return Promise.resolve(
            json({ category: current }, options.method === 'POST' ? 201 : 200),
          );
        }
        return Promise.resolve(json({ categories: [current] }));
      });
    vi.stubGlobal('fetch', fetchMock);
    render(<Catalog {...props} kind="categories" canEdit />);
    await screen.findByRole('cell', { name: 'Materials' });
    fireEvent.click(screen.getByRole('button', { name: 'New category' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: ' Packaging ' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Create category' }));
    expect(
      await screen.findByRole('cell', { name: 'Packaging' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/organizations/org-1/categories',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': 'test-csrf',
        },
        body: JSON.stringify({ name: 'Packaging', description: null }),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Packing materials' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Edit category' }));
    expect(
      await screen.findByRole('cell', { name: 'Packing materials' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/organizations/org-1/categories/category-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() =>
      expect(
        screen.getByRole('cell', { name: 'Inactive' }),
      ).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/organizations/org-1/categories',
      { credentials: 'same-origin', signal: expect.any(AbortSignal) },
    );
  });

  it('preserves an assigned inactive category and normalizes a product SKU', async () => {
    const product = {
      id: 'product-1',
      name: 'Steel',
      sku: 'STEEL',
      description: null,
      active: true,
      categoryId: category.id,
      unitOfMeasure: 'KG',
      quantityScale: 3,
    };
    const fetchMock = vi
      .fn()
      .mockImplementation((path: string, options: RequestInit) => {
        if (options.method) return Promise.resolve(json({ product }));
        return Promise.resolve(
          json(
            path.endsWith('/categories')
              ? { categories: [{ ...category, active: false }] }
              : { products: [product] },
          ),
        );
      });
    vi.stubGlobal('fetch', fetchMock);
    render(<Catalog {...props} kind="products" canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(
      screen.getByRole('option', { name: 'Materials (inactive)' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toHaveValue(category.id);
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: '' },
    });
    expect(
      screen.getByRole('option', { name: 'Materials (inactive)' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: category.id },
    });
    fireEvent.change(screen.getByLabelText('SKU'), {
      target: { value: ' steel-v2 ' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Edit product' }));
    await screen.findByRole('status');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/organizations/org-1/products/product-1',
      expect.objectContaining({
        body: JSON.stringify({
          name: 'Steel',
          description: null,
          sku: 'STEEL-V2',
          categoryId: category.id,
          unitOfMeasure: 'KG',
          quantityScale: 3,
        }),
      }),
    );
  });

  it('retains the form and reports conflicts without displaying server internals', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((_path: string, options: RequestInit) =>
          Promise.resolve(
            options.method
              ? json({ secret: 'internal SQL' }, 409)
              : json({ warehouses: [] }),
          ),
        ),
    );
    render(<Catalog {...props} kind="warehouses" canEdit />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'New warehouse' }),
    );
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Main' },
    });
    fireEvent.change(screen.getByLabelText('Code'), {
      target: { value: 'MAIN' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Create warehouse' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'already exists',
    );
    expect(
      screen.getByRole('form', { name: 'Create warehouse' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('internal SQL')).not.toBeInTheDocument();
  });
});
