import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Operations } from './Operations';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const props = {
  organizationId: 'org',
  csrfToken: 'csrf',
  onExpired: vi.fn(),
  navigate: vi.fn(),
};
afterEach(() => vi.unstubAllGlobals());
it('renders operational metrics and quick links without inventing financial values', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      json({
        dashboard: {
          activeProducts: 12,
          activeWarehouses: 2,
          lowStockProducts: 3,
          outOfStockProducts: 4,
          purchaseOrders: {
            DRAFT: 5,
            SENT: 6,
            PARTIALLY_RECEIVED: 7,
            recentReceived: 8,
          },
          recentMovements: [],
          recentReceipts: [],
        },
      }),
    ),
  );
  render(<Operations {...props} view="dashboard" canEdit={false} />);
  expect(await screen.findByText('12')).toBeInTheDocument();
  expect(screen.getByText('Low stock products')).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Review critical inventory' }),
  );
  expect(props.navigate).toHaveBeenCalledWith('alerts');
});
it('shows exact alert quantities, supports next page and hides settings from MEMBER', async () => {
  const row = {
    id: 'a',
    quantity: '0.000001',
    minimumQuantity: '0.000002',
    status: 'LOW',
    product: { id: 'p', sku: 'P', name: 'Rice', unitOfMeasure: 'KG' },
    warehouse: { id: 'w', code: 'W', name: 'Main' },
  };
  const mock = vi.fn().mockImplementation((path: string) =>
    Promise.resolve(
      json({
        alerts: [{ ...row, id: path.includes('offset=50') ? 'b' : 'a' }],
        nextOffset: path.includes('offset=50') ? null : 50,
      }),
    ),
  );
  vi.stubGlobal('fetch', mock);
  render(<Operations {...props} view="alerts" canEdit={false} />);
  expect(await screen.findByText('0.000001 KG')).toBeInTheDocument();
  expect(
    screen.queryByRole('form', { name: 'Configure minimum stock' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more alerts' }));
  await waitFor(() =>
    expect(screen.getAllByText('0.000001 KG')).toHaveLength(2),
  );
  fireEvent.change(screen.getByLabelText('Alert status'), {
    target: { value: 'LOW' },
  });
  await waitFor(() =>
    expect(
      mock.mock.calls.some(([path]) => String(path).includes('status=LOW')),
    ).toBe(true),
  );
});
it('prevents MEMBER audit requests and renders no audit table', () => {
  const mock = vi.fn();
  vi.stubGlobal('fetch', mock);
  render(<Operations {...props} view="audit" canEdit={false} />);
  expect(
    screen.getByText('Audit access requires OWNER or ADMIN.'),
  ).toBeInTheDocument();
  expect(mock).not.toHaveBeenCalled();
});
it('submits minimum quantities as strings with CSRF protection', async () => {
  const mock = vi
    .fn()
    .mockImplementation((path: string, init: RequestInit = {}) =>
      Promise.resolve(
        json(
          init.method
            ? { threshold: {} }
            : path.endsWith('/products')
              ? {
                  products: [
                    {
                      id: 'p',
                      sku: 'P',
                      name: 'Rice',
                      active: true,
                      unitOfMeasure: 'KG',
                    },
                  ],
                }
              : path.endsWith('/warehouses')
                ? {
                    warehouses: [
                      { id: 'w', code: 'W', name: 'Main', active: true },
                    ],
                  }
                : { alerts: [] },
        ),
      ),
    );
  vi.stubGlobal('fetch', mock);
  render(<Operations {...props} view="alerts" canEdit />);
  await screen.findByRole('option', { name: 'P · Rice (KG)' });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save minimum stock' }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText('Minimum stock product'), {
    target: { value: 'p' },
  });
  fireEvent.change(screen.getByLabelText('Minimum stock warehouse'), {
    target: { value: 'w' },
  });
  fireEvent.change(screen.getByLabelText('Minimum quantity'), {
    target: { value: '0.000001' },
  });
  fireEvent.submit(
    screen.getByRole('form', { name: 'Configure minimum stock' }),
  );
  expect(await screen.findByText('Minimum stock saved.')).toBeInTheDocument();
  const write = mock.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(write![1].body as string).minimumQuantity).toBe('0.000001');
  expect(write![1].headers['X-CSRF-Token']).toBe('csrf');
});
it('bounds the critical inventory preview and shows exact quantities with status badges', async () => {
  const mock = vi.fn().mockImplementation((path: string) =>
    Promise.resolve(
      json(
        path.endsWith('/dashboard')
          ? {
              dashboard: {
                activeProducts: 1,
                activeWarehouses: 1,
                lowStockProducts: 1,
                outOfStockProducts: 0,
                purchaseOrders: {
                  DRAFT: 0,
                  SENT: 0,
                  PARTIALLY_RECEIVED: 0,
                  recentReceived: 0,
                },
                recentMovements: [],
                recentReceipts: [],
              },
            }
          : {
              alerts: path.includes('status=LOW')
                ? [
                    {
                      id: 'critical',
                      quantity: '2.500000',
                      minimumQuantity: '5.000000',
                      status: 'LOW',
                      product: {
                        id: 'p',
                        sku: 'NOVA-01',
                        name: 'Nova rice',
                        unitOfMeasure: 'KG',
                      },
                      warehouse: { id: 'w', code: 'MAIN', name: 'Central' },
                    },
                  ]
                : [],
            },
      ),
    ),
  );
  vi.stubGlobal('fetch', mock);
  render(<Operations {...props} view="dashboard" canEdit={false} />);
  expect(await screen.findByText('Nova rice')).toBeInTheDocument();
  expect(screen.getByText('2.500000 KG')).toBeInTheDocument();
  expect(screen.getByTitle('Low stock')).toHaveTextContent('LOW');
  expect(
    mock.mock.calls
      .map(([path]) => path)
      .filter((path: string) => path.includes('/inventory/alerts')),
  ).toEqual([
    '/api/organizations/org/inventory/alerts?status=OUT_OF_STOCK&limit=3',
    '/api/organizations/org/inventory/alerts?status=LOW&limit=3',
  ]);
});
it('keeps dashboard metrics available when critical inventory cannot be loaded', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string) =>
      path.endsWith('/dashboard')
        ? Promise.resolve(
            json({
              dashboard: {
                activeProducts: 42,
                activeWarehouses: 1,
                lowStockProducts: 0,
                outOfStockProducts: 0,
                purchaseOrders: {
                  DRAFT: 0,
                  SENT: 0,
                  PARTIALLY_RECEIVED: 0,
                  recentReceived: 0,
                },
                recentMovements: [],
                recentReceipts: [],
              },
            }),
          )
        : Promise.resolve(new Response(null, { status: 429 })),
    ),
  );
  render(<Operations {...props} view="dashboard" canEdit={false} />);
  expect(await screen.findByText('42')).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Critical inventory could not be loaded',
  );
  expect(
    screen.getByRole('button', { name: 'Refresh dashboard' }),
  ).toBeEnabled();
});
it('makes audit actions readable while retaining exact technical references', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      json({
        events: [
          {
            id: 'event',
            action: 'ISSUE',
            entityType: 'InventoryMovement',
            entityId: 'movement-id',
            correlationKey: 'command-id',
            createdAt: '2026-10-17T12:00:00Z',
            actor: { displayName: 'Demo Operator' },
          },
        ],
      }),
    ),
  );
  render(<Operations {...props} view="audit" canEdit />);
  expect(await screen.findByText('Stock issued')).toBeInTheDocument();
  expect(screen.getByText('ISSUE')).toBeInTheDocument();
  expect(screen.getByText('command-id').closest('details')).not.toHaveAttribute(
    'open',
  );
  fireEvent.click(screen.getByText('Operation reference'));
  expect(screen.getByText('command-id').closest('details')).toHaveAttribute(
    'open',
  );
});
