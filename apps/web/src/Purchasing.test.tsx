import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
} from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { Purchasing } from './Purchasing';

const supplier = {
  id: 'supplier',
  name: 'Grain supplier',
  active: true,
  legalName: null,
  taxId: null,
  email: null,
  phone: null,
  notes: null,
};
const product = {
  id: 'product',
  sku: 'RICE',
  name: 'Rice',
  unitOfMeasure: 'KG',
  active: true,
};
const order = {
  id: 'order',
  supplier,
  status: 'DRAFT',
  creator: { id: 'owner', displayName: 'Owner' },
  createdAt: '2026-10-17T12:00:00.000Z',
  sentAt: null,
  cancelledAt: null,
  cancellationReason: null,
  notes: null,
  lines: [
    {
      id: 'line',
      product,
      orderedQuantity: '2.500000',
      receivedQuantity: '0.000000',
      pendingQuantity: '2.500000',
      cancelledQuantity: '0.000000',
    },
  ],
};
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const props = { organizationId: 'org', csrfToken: 'csrf', onExpired: () => {} };
afterEach(() => vi.unstubAllGlobals());
const receipt = {
  id: 'receipt-1',
  createdAt: order.createdAt,
  warehouse: { id: 'warehouse', code: 'MAIN', name: 'Main warehouse' },
  actor: order.creator,
  lines: [
    {
      id: 'receipt-line',
      product,
      receivedQuantity: '1.500000',
      inventoryMovement: { id: 'movement-1', correlationKey: 'receipt-1' },
    },
  ],
};
function listing(path: string) {
  return json(
    path.endsWith('/suppliers')
      ? { suppliers: [supplier] }
      : path.endsWith('/products')
        ? { products: [product] }
        : path.endsWith('/purchase-orders')
          ? { purchaseOrders: [order] }
          : path.endsWith('/receipts')
            ? { receipts: [] }
            : path.endsWith('/warehouses')
              ? {
                  warehouses: [
                    {
                      id: 'warehouse',
                      code: 'MAIN',
                      name: 'Main warehouse',
                      active: true,
                    },
                  ],
                }
              : { purchaseOrder: order },
  );
}

it('allows MEMBER to inspect exact quantities but hides purchasing writes', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation((path: string) => Promise.resolve(listing(path))),
  );
  render(<Purchasing {...props} canEdit={false} />);
  await screen.findByRole('button', { name: 'View order order' });
  expect(
    screen.queryByRole('button', { name: 'New supplier' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'New purchase order' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View order order' }));
  expect(await screen.findAllByText('2.500000')).toHaveLength(2);
  expect(
    screen.queryByRole('button', { name: 'Edit draft' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Send order' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Cancel order' }),
  ).not.toBeInTheDocument();
});

it('shows MEMBER receipt history and authoritative pending quantities without receiving controls', async () => {
  const partial = {
    ...order,
    status: 'PARTIALLY_RECEIVED',
    lines: [
      {
        ...order.lines[0],
        receivedQuantity: '1.500000',
        pendingQuantity: '1.000000',
      },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve(
          path.endsWith('/receipts')
            ? json({ receipts: [receipt] })
            : path.endsWith('/order')
              ? json({ purchaseOrder: partial })
              : listing(path),
        ),
      ),
  );
  render(<Purchasing {...props} canEdit={false} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'View order order' }),
  );
  const history = await screen.findByRole('table', {
    name: 'Purchase receipts',
  });
  await within(history).findByText('Owner');
  expect(within(history).getByText(/movement-1/)).toBeInTheDocument();
  const lines = within(screen.getByRole('table', { name: 'Order lines' }));
  expect(lines.getByText('1.000000')).toBeInTheDocument();
  expect(lines.getByText('1.500000')).toBeInTheDocument();
  expect(
    screen.queryByRole('form', { name: 'Receive purchase order' }),
  ).not.toBeInTheDocument();
});

it('reuses a receipt intent after network failure and updates quantities and history after confirmation', async () => {
  const writes: RequestInit[] = [];
  let current = { ...order, status: 'SENT' };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init: RequestInit = {}) => {
      if (init.method) {
        writes.push(init);
        if (writes.length === 1) return Promise.reject(Error('Timeout'));
        current = {
          ...order,
          status: 'PARTIALLY_RECEIVED',
          lines: [
            {
              ...order.lines[0]!,
              receivedQuantity: '1.500000',
              pendingQuantity: '1.000000',
            },
          ],
        };
        return Promise.resolve(json({ purchaseOrder: current, receipt }));
      }
      return Promise.resolve(
        path.endsWith('/order')
          ? json({ purchaseOrder: current })
          : path.endsWith('/receipts')
            ? json({ receipts: writes.length > 1 ? [receipt] : [] })
            : listing(path),
      );
    }),
  );
  render(<Purchasing {...props} canEdit />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'View order order' }),
  );
  await screen.findByRole('option', { name: 'MAIN · Main warehouse' });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Record receipt' }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText('Receipt warehouse'), {
    target: { value: 'warehouse' },
  });
  fireEvent.change(screen.getByLabelText('Receive line 1 quantity'), {
    target: { value: '1.500' },
  });
  fireEvent.submit(
    screen.getByRole('form', { name: 'Receive purchase order' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Retry the same values',
  );
  fireEvent.submit(
    screen.getByRole('form', { name: 'Receive purchase order' }),
  );
  await screen.findByText('Receipt recorded.');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.headers).toEqual(writes[1]!.headers);
  expect(JSON.parse(writes[1]!.body as string)).toEqual({
    warehouseId: 'warehouse',
    lines: [{ purchaseOrderLineId: 'line', quantity: '1.500' }],
  });
  expect(
    screen.getByRole('region', { name: 'Purchase order detail' }),
  ).toHaveTextContent('PARTIALLY_RECEIVED');
  await within(
    screen.getByRole('table', { name: 'Purchase receipts' }),
  ).findByText('Owner');
  expect(screen.getByLabelText('Receive line 1 quantity')).toHaveValue('');
  expect(
    screen.getByRole('button', { name: 'Cancel order' }),
  ).toBeInTheDocument();
});

it('preserves exact draft quantities and the command key after a network failure, then locks sent lines', async () => {
  const writes: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init: RequestInit = {}) => {
      if (init.method) {
        writes.push({ path, init });
        if (writes.length === 1) return Promise.reject(Error('Timeout'));
        return Promise.resolve(
          json({
            purchaseOrder: path.endsWith('/send')
              ? { ...order, status: 'SENT', sentAt: order.createdAt }
              : order,
          }),
        );
      }
      return Promise.resolve(listing(path));
    }),
  );
  render(<Purchasing {...props} canEdit />);
  await screen.findByRole('button', { name: 'View order order' });
  fireEvent.click(screen.getByRole('button', { name: 'New purchase order' }));
  fireEvent.change(screen.getByLabelText('Order supplier'), {
    target: { value: supplier.id },
  });
  fireEvent.change(screen.getByLabelText('Line 1 product'), {
    target: { value: product.id },
  });
  fireEvent.change(screen.getByLabelText('Line 1 quantity'), {
    target: { value: '2.500' },
  });
  fireEvent.submit(screen.getByRole('form', { name: 'Purchase order editor' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Retry the same values',
  );
  fireEvent.submit(screen.getByRole('form', { name: 'Purchase order editor' }));
  await screen.findByText('Draft saved.');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.init.headers).toEqual(writes[1]!.init.headers);
  expect(
    (writes[0]!.init.headers as Record<string, string>)['Idempotency-Key'],
  ).toBeTruthy();
  expect(JSON.parse(writes[0]!.init.body as string)).toEqual({
    supplierId: supplier.id,
    notes: null,
    lines: [{ productId: product.id, orderedQuantity: '2.500' }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send order' }));
  await screen.findByText('Order sent.');
  const detail = within(
    screen.getByRole('region', { name: 'Purchase order detail' }),
  );
  expect(detail.getByText('SENT')).toBeInTheDocument();
  expect(
    detail.queryByRole('button', { name: 'Edit draft' }),
  ).not.toBeInTheDocument();
  expect(
    detail.queryByRole('button', { name: 'Send order' }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(writes[2]!.path).toMatch(/\/order\/send$/);
});
