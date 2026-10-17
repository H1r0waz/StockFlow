import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Imports, Reports } from './DataExchange';
const props = {
  organizationId: 'org',
  csrfToken: 'csrf',
  canEdit: true,
  onExpired: vi.fn(),
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const preview = {
  id: 'p',
  type: 'products',
  totalRows: 1,
  validRows: 1,
  invalidRows: 0,
  createdRows: 1,
  updatedRows: 0,
  skippedRows: 0,
  token: 'signed',
  expiresAt: '2099-01-01T00:00:00Z',
  rows: [{ row: 2, operation: 'CREATE', data: { sku: 'RICE' }, errors: [] }],
};
async function file() {
  const upload = new File(['sku,name\nRICE,Rice'], 'products.csv', {
    type: 'text/csv',
  });
  Object.defineProperty(upload, 'arrayBuffer', {
    value: async () => new TextEncoder().encode('sku,name\nRICE,Rice').buffer,
  });
  fireEvent.change(screen.getByLabelText('CSV file'), {
    target: { files: [upload] },
  });
  await screen.findByText('Selected file: products.csv');
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each([403, 429])(
  'explains report permission or throttling failures (%s)',
  async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, status)));
    render(<Reports {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      status === 403 ? 'permission' : 'Too many requests',
    );
  },
);
it('previews without writes and retries confirmation with identical payload after network uncertainty', async () => {
  const mock = vi
    .fn()
    .mockResolvedValueOnce(json({ preview }))
    .mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValueOnce(
      json(
        {
          job: {
            id: 'job',
            status: 'CONFIRMED',
            createdRows: 1,
            updatedRows: 0,
            skippedRows: 0,
            failedRows: 0,
          },
        },
        201,
      ),
    );
  vi.stubGlobal('fetch', mock);
  render(<Imports {...props} />);
  await file();
  expect(mock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Preview import'));
  await screen.findByRole('button', { name: 'Confirm import' });
  expect(mock.mock.calls[0]?.[0]).toContain('/preview');
  expect(mock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Confirm import'));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByText('Confirm import'));
  await screen.findByText('Import confirmed');
  expect(mock.mock.calls[1]?.[1].body).toEqual(mock.mock.calls[2]?.[1].body);
  expect(JSON.parse(mock.mock.calls[2]?.[1].body)).toEqual({
    csv: 'sku,name\nRICE,Rice',
    token: 'signed',
  });
});
it('blocks invalid rows and invalidates an accepted preview when the import type changes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      json({
        preview: {
          ...preview,
          invalidRows: 1,
          validRows: 0,
          rows: [{ row: 2, operation: 'ERROR', errors: ['Invalid SKU'] }],
        },
      }),
    ),
  );
  render(<Imports {...props} />);
  await file();
  fireEvent.click(screen.getByText('Preview import'));
  expect(await screen.findByText('Invalid SKU')).toBeInTheDocument();
  expect(screen.getByText('Confirm import')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Import type'), {
    target: { value: 'suppliers' },
  });
  expect(screen.queryByText('Confirm import')).not.toBeInTheDocument();
});
it('requires a fresh preview on conflict and retains no actionable stale token', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(json({ preview }))
      .mockResolvedValueOnce(json({}, 409)),
  );
  render(<Imports {...props} />);
  await file();
  fireEvent.click(screen.getByText('Preview import'));
  await screen.findByText('Confirm import');
  fireEvent.click(screen.getByText('Confirm import'));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'stale or expired',
  );
  expect(screen.queryByText('Confirm import')).not.toBeInTheDocument();
});
it('does not offer import controls to members', () => {
  const mock = vi.fn();
  vi.stubGlobal('fetch', mock);
  render(<Imports {...props} canEdit={false} />);
  expect(screen.queryByLabelText('CSV file')).not.toBeInTheDocument();
  expect(mock).not.toHaveBeenCalled();
});
it('bounds report pages and exports the same filters without offering member audit', async () => {
  const mock = vi.fn().mockImplementation((path: string) =>
    Promise.resolve(
      path.includes('/exports/')
        ? new Response('SKU,Product\nRICE,Rice')
        : json({
            columns: ['SKU', 'Product'],
            rows: [{ SKU: 'RICE', Product: 'Rice' }],
            hasMore: !path.includes('offset=50'),
            nextOffset: path.includes('offset=50') ? null : 50,
          }),
    ),
  );
  vi.stubGlobal('fetch', mock);
  const create = vi.fn().mockReturnValue('blob:test');
  const revoke = vi.fn();
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<Reports {...props} canEdit={false} />);
  await screen.findByText('Rice');
  expect(
    screen.queryByRole('option', { name: 'audit' }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Report active'), {
    target: { value: 'true' },
  });
  await waitFor(() =>
    expect(
      mock.mock.calls.some(([path]) => String(path).includes('active=true')),
    ).toBe(true),
  );
  await screen.findByText('Rice');
  fireEvent.click(screen.getByText('Next report page'));
  await screen.findByText('Rows 51–51');
  fireEvent.click(screen.getByText('Export CSV page'));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(mock.mock.calls.at(-1)?.[0]).toContain(
    '/exports/products?active=true&limit=50&offset=50',
  );
  expect(revoke).toHaveBeenCalledWith('blob:test');
});
it('rejects oversized files and invalid UTF-8 before any API request', async () => {
  const mock = vi.fn();
  vi.stubGlobal('fetch', mock);
  render(<Imports {...props} />);
  const oversized = new File(['x'], 'large.csv');
  Object.defineProperty(oversized, 'size', { value: 262145 });
  fireEvent.change(screen.getByLabelText('CSV file'), {
    target: { files: [oversized] },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('256 KiB');
  const invalid = new File(['x'], 'invalid.csv');
  Object.defineProperty(invalid, 'arrayBuffer', {
    value: async () => new Uint8Array([255]).buffer,
  });
  fireEvent.change(screen.getByLabelText('CSV file'), {
    target: { files: [invalid] },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('valid UTF-8');
  expect(mock).not.toHaveBeenCalled();
});
