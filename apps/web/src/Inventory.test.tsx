import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { Inventory } from './Inventory';
const p = {
  id: 'p',
  sku: 'RICE',
  name: 'Rice',
  unitOfMeasure: 'KG',
  active: true,
};
const w = { id: 'w', code: 'MAIN', name: 'Main', active: true };
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const props = { organizationId: 'org', csrfToken: 'csrf', onExpired: () => {} };
afterEach(() => vi.unstubAllGlobals());
function data(path: string) {
  return json(
    path.endsWith('/products')
      ? { products: [p] }
      : path.endsWith('/warehouses')
        ? { warehouses: [w] }
        : path.includes('/balances')
          ? {
              balances: [
                {
                  id: 'b',
                  product: p,
                  warehouse: w,
                  quantity: '5.250000',
                  version: '1',
                },
              ],
            }
          : { movements: [] },
  );
}
it('shows exact balances and hides commands from MEMBER', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string) => Promise.resolve(data(path))),
  );
  render(<Inventory {...props} canEdit={false} />);
  expect(await screen.findByText('5.250000')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Record movement' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('form', { name: 'Transfer stock' }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Product search'), {
    target: { value: 'Unknown' },
  });
  expect(screen.getByText(/No stock balances match/)).toBeInTheDocument();
});
it.each([404, 429])(
  'explains stock command recovery for HTTP %s',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((path: string, init: RequestInit = {}) =>
          Promise.resolve(
            init.method ? new Response('{}', { status }) : data(path),
          ),
        ),
    );
    render(<Inventory {...props} canEdit />);
    await screen.findByText('5.250000');
    fireEvent.change(screen.getByLabelText('Product', { exact: true }), {
      target: { value: 'p' },
    });
    fireEvent.change(screen.getByLabelText('Warehouse', { exact: true }), {
      target: { value: 'w' },
    });
    fireEvent.change(screen.getByLabelText('Quantity', { exact: true }), {
      target: { value: '1' },
    });
    fireEvent.submit(
      screen.getByRole('form', { name: 'Record stock movement' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      status === 404 ? 'no longer available' : 'Too many requests',
    );
  },
);
it('reuses the idempotency key after an ambiguous network failure', async () => {
  let failed = false;
  const keys: string[] = [];
  const mock = vi
    .fn()
    .mockImplementation((path: string, init: RequestInit = {}) => {
      if (init.method) {
        keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
        if (!failed) {
          failed = true;
          return Promise.reject(Error('Network timeout'));
        }
        return Promise.resolve(json({}));
      }
      return Promise.resolve(data(path));
    });
  vi.stubGlobal('fetch', mock);
  render(<Inventory {...props} canEdit />);
  await screen.findByText('5.250000');
  fireEvent.change(screen.getByLabelText('Product', { exact: true }), {
    target: { value: 'p' },
  });
  fireEvent.change(screen.getByLabelText('Warehouse', { exact: true }), {
    target: { value: 'w' },
  });
  fireEvent.change(screen.getByLabelText('Quantity', { exact: true }), {
    target: { value: '1.250' },
  });
  fireEvent.submit(screen.getByRole('form', { name: 'Record stock movement' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Retry the same values',
  );
  fireEvent.submit(screen.getByRole('form', { name: 'Record stock movement' }));
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(await screen.findByText('Movement recorded.')).toBeInTheDocument();
});

it('checks source availability, rejects equal warehouses and retries one transfer intent', async () => {
  const destination = { id: 'd', code: 'SECOND', name: 'Second', active: true };
  const posts: RequestInit[] = [];
  let completed = false;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init: RequestInit = {}) => {
      if (init.method === 'POST') {
        posts.push(init);
        if (posts.length === 1) return Promise.reject(Error('Network timeout'));
        completed = true;
        return Promise.resolve(json({}));
      }
      if (path.endsWith('/warehouses'))
        return Promise.resolve(json({ warehouses: [w, destination] }));
      if (completed && path.includes('/movements'))
        return Promise.resolve(
          json({
            movements: [w, destination].map((warehouse, index) => ({
              id: `movement-${index}`,
              type: index === 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN',
              quantity: '1.250000',
              previousBalance: index === 0 ? '5.250000' : '0.000000',
              resultingBalance: index === 0 ? '4.000000' : '1.250000',
              product: p,
              warehouse,
              actor: { id: 'actor', displayName: 'Owner' },
              createdAt: '2026-10-17T12:00:00.000Z',
              transferId: 'shared-transfer',
              correlationId: 'shared-transfer',
            })),
          }),
        );
      return Promise.resolve(data(path));
    }),
  );
  render(<Inventory {...props} canEdit />);
  await screen.findByText('5.250000');
  fireEvent.change(screen.getByLabelText('Transfer product'), {
    target: { value: 'p' },
  });
  fireEvent.change(screen.getByLabelText('Source warehouse'), {
    target: { value: 'w' },
  });
  expect(
    await screen.findByText('Available in source: 5.250000 KG'),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Destination warehouse'), {
    target: { value: 'w' },
  });
  fireEvent.change(screen.getByLabelText('Transfer quantity'), {
    target: { value: '1.250' },
  });
  const form = screen.getByRole('form', { name: 'Transfer stock' });
  fireEvent.submit(form);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Choose different origin and destination',
  );
  expect(posts).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Destination warehouse'), {
    target: { value: 'd' },
  });
  fireEvent.submit(form);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Retry the same values',
  );
  fireEvent.submit(form);
  expect(await screen.findByText('Transfer recorded.')).toBeInTheDocument();
  expect(posts).toHaveLength(2);
  expect(posts[0]!.headers).toEqual(posts[1]!.headers);
  expect(
    (posts[0]!.headers as Record<string, string>)['Idempotency-Key'],
  ).toBeTruthy();
  expect((posts[0]!.headers as Record<string, string>)['X-CSRF-Token']).toBe(
    'csrf',
  );
  expect(JSON.parse(posts[0]!.body as string)).toEqual({
    productId: 'p',
    sourceWarehouseId: 'w',
    destinationWarehouseId: 'd',
    quantity: '1.250',
  });
  expect(await screen.findAllByText('shared-transfer')).toHaveLength(2);
  const history = within(
    screen.getByRole('table', { name: 'Movement history' }),
  );
  expect(history.getByText('Transfer out')).toBeInTheDocument();
  expect(history.getByText('Transfer in')).toBeInTheDocument();
});
