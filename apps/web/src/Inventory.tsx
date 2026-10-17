import { useEffect, useRef, useState, type FormEvent } from 'react';

type Product = {
  id: string;
  sku: string;
  name: string;
  unitOfMeasure: string;
  active: boolean;
};
type Warehouse = { id: string; code: string; name: string; active: boolean };
type Balance = {
  id: string;
  quantity: string;
  version: string;
  product: Product;
  warehouse: Warehouse;
};
type Movement = {
  id: string;
  type: string;
  quantity: string;
  previousBalance: string;
  resultingBalance: string;
  product: Product;
  warehouse: Warehouse;
  actor: { id: string; displayName: string };
  createdAt: string;
  transferId?: string | null;
  correlationId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
};
type Fields = {
  type: string;
  productId: string;
  warehouseId: string;
  quantity: string;
  reason: string;
};
const initial: Fields = {
  type: 'RECEIPT',
  productId: '',
  warehouseId: '',
  quantity: '',
  reason: '',
};
const types = {
  RECEIPT: 'Receipt',
  ISSUE: 'Issue',
  ADJUSTMENT_IN: 'Adjustment in',
  ADJUSTMENT_OUT: 'Adjustment out',
};
const historyTypes = {
  ...types,
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
};
class InventoryError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super('Inventory request failed');
  }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(30_000),
    ...init,
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    throw new InventoryError(response.status, data?.error?.code ?? '');
  }
  return response.json() as Promise<T>;
}

export function Inventory({
  organizationId,
  csrfToken,
  canEdit,
  onExpired,
}: {
  organizationId: string;
  csrfToken: string;
  canEdit: boolean;
  onExpired: () => void;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [search, setSearch] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [fields, setFields] = useState(initial);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [pages, setPages] = useState<Record<string, number | null>>({});
  const [transfer, setTransfer] = useState({
    productId: '',
    sourceWarehouseId: '',
    destinationWarehouseId: '',
    quantity: '',
  });
  const [available, setAvailable] = useState<string | null>(null);
  const transferIntent = useRef<{ body: string; key: string } | null>(null);
  const intent = useRef<{ body: string; path: string; key: string } | null>(
    null,
  );
  const base = `/api/organizations/${encodeURIComponent(organizationId)}`;
  async function more(
    kind: 'products' | 'warehouses' | 'balances' | 'movements',
  ) {
    if (pages[kind] == null || busy) return;
    setBusy(true);
    setError('');
    const query = new URLSearchParams({ offset: String(pages[kind]) });
    if ((kind === 'balances' || kind === 'movements') && warehouseFilter)
      query.set('warehouseId', warehouseFilter);
    if (kind === 'movements' && typeFilter) query.set('type', typeFilter);
    try {
      const data = await request<{
        products?: Product[];
        warehouses?: Warehouse[];
        balances?: Balance[];
        movements?: Movement[];
        nextOffset?: number | null;
      }>(
        `${base}/${kind === 'products' || kind === 'warehouses' ? kind : `inventory/${kind}`}?${query}`,
      );
      if (data.products) setProducts((old) => [...old, ...data.products!]);
      if (data.warehouses)
        setWarehouses((old) => [...old, ...data.warehouses!]);
      if (data.balances) setBalances((old) => [...old, ...data.balances!]);
      if (data.movements) setMovements((old) => [...old, ...data.movements!]);
      setPages((old) => ({ ...old, [kind]: data.nextOffset ?? null }));
    } catch (failure) {
      if (failure instanceof InventoryError && failure.status === 401)
        onExpired();
      else setError('Unable to load more inventory. Please retry.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const filters = new URLSearchParams();
    if (warehouseFilter) filters.set('warehouseId', warehouseFilter);
    const movementFilters = new URLSearchParams(filters);
    if (typeFilter) movementFilters.set('type', typeFilter);
    Promise.all([
      request<{ products: Product[]; nextOffset?: number | null }>(
        `${base}/products`,
      ),
      request<{ warehouses: Warehouse[]; nextOffset?: number | null }>(
        `${base}/warehouses`,
      ),
      request<{
        balances: Balance[];
        hasMore?: boolean;
        nextOffset?: number | null;
      }>(`${base}/inventory/balances?${filters}`),
      request<{
        movements: Movement[];
        hasMore?: boolean;
        nextOffset?: number | null;
      }>(`${base}/inventory/movements?${movementFilters}`),
    ])
      .then(([p, w, b, m]) => {
        if (!cancelled) {
          setProducts(p.products);
          setWarehouses(w.warehouses);
          setBalances(b.balances);
          setMovements(m.movements);
          setPages({
            products: p.nextOffset ?? null,
            warehouses: w.nextOffset ?? null,
            balances: b.nextOffset ?? null,
            movements: m.nextOffset ?? null,
          });
        }
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        if (failure instanceof InventoryError && failure.status === 401)
          onExpired();
        else setError('Unable to load inventory. Please retry.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, warehouseFilter, typeFilter, reload, onExpired]);

  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    if (transfer.productId && transfer.sourceWarehouseId) {
      const filters = new URLSearchParams({
        productId: transfer.productId,
        warehouseId: transfer.sourceWarehouseId,
      });
      request<{ balances: Balance[] }>(`${base}/inventory/balances?${filters}`)
        .then(({ balances: source }) => {
          if (!cancelled) setAvailable(source[0]?.quantity ?? '0.000000');
        })
        .catch((failure: unknown) => {
          if (
            !cancelled &&
            failure instanceof InventoryError &&
            failure.status === 401
          )
            onExpired();
          // Unknown availability stays unknown; the command revalidates stock.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [base, transfer.productId, transfer.sourceWarehouseId, reload, onExpired]);

  function changeTransfer(key: keyof typeof transfer, value: string) {
    transferIntent.current = null;
    setTransfer((previous) => ({ ...previous, [key]: value }));
    setNotice('');
  }
  async function transferStock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setNotice('');
    if (transfer.sourceWarehouseId === transfer.destinationWarehouseId) {
      setError('Choose different origin and destination warehouses.');
      return;
    }
    const body = JSON.stringify({
      ...transfer,
      quantity: transfer.quantity.trim(),
    });
    if (!transferIntent.current || transferIntent.current.body !== body)
      transferIntent.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    try {
      await request(`${base}/inventory/transfers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          'Idempotency-Key': transferIntent.current.key,
        },
        body,
      });
      transferIntent.current = null;
      setTransfer((previous) => ({ ...previous, quantity: '' }));
      setNotice('Transfer recorded.');
      setReload((previous) => previous + 1);
    } catch (failure) {
      if (failure instanceof InventoryError && failure.status === 401)
        onExpired();
      else
        setError(
          failure instanceof InventoryError && failure.status === 429
            ? 'Too many requests. Wait before retrying the same values.'
            : failure instanceof InventoryError && failure.status === 404
              ? 'A selected record is no longer available. Reload inventory and check the records.'
              : failure instanceof InventoryError && failure.status === 409
                ? 'The transfer conflicts with available stock, active records, or a previous request. Check the values before changing them.'
                : failure instanceof InventoryError && failure.status === 400
                  ? 'Check the quantity, product precision and warehouse selection.'
                  : failure instanceof InventoryError && failure.status === 403
                    ? 'You do not have permission to transfer stock. Refresh your session.'
                    : 'The transfer result could not be confirmed. Retry the same values to safely check this request.',
        );
    } finally {
      setBusy(false);
    }
  }

  function change(key: keyof Fields, value: string) {
    intent.current = null;
    setFields((previous) => ({ ...previous, [key]: value }));
    setNotice('');
  }
  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const adjustment = fields.type.startsWith('ADJUSTMENT');
    const path = `${base}/inventory/${adjustment ? 'adjustments' : fields.type === 'ISSUE' ? 'issues' : 'receipts'}`;
    const body = JSON.stringify({
      productId: fields.productId,
      warehouseId: fields.warehouseId,
      quantity: fields.quantity.trim(),
      ...(fields.reason.trim() ? { reason: fields.reason.trim() } : {}),
      ...(adjustment
        ? { direction: fields.type === 'ADJUSTMENT_IN' ? 'IN' : 'OUT' }
        : {}),
    });
    if (
      !intent.current ||
      intent.current.body !== body ||
      intent.current.path !== path
    )
      intent.current = { body, path, key: crypto.randomUUID() };
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          'Idempotency-Key': intent.current.key,
        },
        body,
      });
      intent.current = null;
      setFields((previous) => ({ ...previous, quantity: '', reason: '' }));
      setNotice('Movement recorded.');
      setReload((previous) => previous + 1);
    } catch (failure) {
      if (failure instanceof InventoryError && failure.status === 401)
        onExpired();
      else
        setError(
          failure instanceof InventoryError && failure.status === 429
            ? 'Too many requests. Wait before retrying the same values.'
            : failure instanceof InventoryError && failure.status === 404
              ? 'A selected record is no longer available. Reload inventory and check the records.'
              : failure instanceof InventoryError && failure.status === 409
                ? 'The movement conflicts with available stock, active records, or a previous request. Check the values before changing them.'
                : failure instanceof InventoryError && failure.status === 400
                  ? 'Check the quantity, product precision and reason. Use a positive decimal quantity without commas or exponent notation.'
                  : failure instanceof InventoryError && failure.status === 403
                    ? 'You do not have permission to record movements. Refresh your session.'
                    : 'The result could not be confirmed. Retry the same values to safely check this request.',
        );
    } finally {
      setBusy(false);
    }
  }
  function matches(product: Product) {
    return `${product.name} ${product.sku}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  }
  return (
    <section className="members-card" aria-labelledby="inventory-title">
      <h2 id="inventory-title">Inventory</h2>
      <p className="muted">
        Current stock and the immutable movement history.{' '}
        {canEdit
          ? 'Record a receipt, issue, adjustment or warehouse transfer.'
          : 'Read-only access.'}
      </p>
      {error && (
        <div role="alert" className="form-error">
          {error}
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setError('');
              setLoading(true);
              setReload((value) => value + 1);
            }}
          >
            Retry loading
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="save-notice">
          {notice}
        </p>
      )}

      <div className="catalog-actions">
        {(['products', 'warehouses'] as const).map(
          (kind) =>
            pages[kind] != null && (
              <button
                key={kind}
                className="secondary-button"
                disabled={busy || loading}
                onClick={() => void more(kind)}
              >
                Load more {kind}
              </button>
            ),
        )}
      </div>
      {canEdit && (
        <form
          className="catalog-form"
          aria-label="Record stock movement"
          onSubmit={record}
        >
          <h3>Record stock movement</h3>
          <div className="catalog-fields">
            <div>
              <label htmlFor="movement-type">Movement type</label>
              <select
                id="movement-type"
                value={fields.type}
                disabled={busy || loading}
                onChange={(event) => change('type', event.target.value)}
              >
                {Object.entries(types).map(([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="movement-product">Product</label>
              <select
                id="movement-product"
                value={fields.productId}
                required
                disabled={busy || loading}
                onChange={(event) => change('productId', event.target.value)}
              >
                <option value="">Choose product</option>
                {products
                  .filter((product) => product.active)
                  .map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.sku} · {product.name} ({product.unitOfMeasure})
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor="movement-warehouse">Warehouse</label>
              <select
                id="movement-warehouse"
                value={fields.warehouseId}
                required
                disabled={busy || loading}
                onChange={(event) => change('warehouseId', event.target.value)}
              >
                <option value="">Choose warehouse</option>
                {warehouses
                  .filter((warehouse) => warehouse.active)
                  .map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.code} · {warehouse.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor="movement-quantity">Quantity</label>
              <input
                id="movement-quantity"
                type="text"
                inputMode="decimal"
                value={fields.quantity}
                required
                pattern="[0-9]+(\.[0-9]{1,6})?"
                maxLength={21}
                disabled={busy || loading}
                onChange={(event) => change('quantity', event.target.value)}
              />
              <p className="field-help">
                Positive decimal in the product's unit. Up to its allowed
                precision.
              </p>
            </div>
            <div>
              <label htmlFor="movement-reason">Reason</label>
              <input
                id="movement-reason"
                value={fields.reason}
                required={fields.type.startsWith('ADJUSTMENT')}
                maxLength={500}
                disabled={busy || loading}
                onChange={(event) => change('reason', event.target.value)}
              />
              <p className="field-help">
                Required for adjustments. Never include secrets.
              </p>
            </div>
          </div>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || loading}
          >
            {busy ? 'Recording…' : 'Record movement'}
          </button>
        </form>
      )}
      {canEdit && (
        <form
          className="catalog-form"
          aria-label="Transfer stock"
          onSubmit={transferStock}
        >
          <h3>Transfer stock</h3>
          <div className="catalog-fields">
            <div>
              <label htmlFor="transfer-product">Transfer product</label>
              <select
                id="transfer-product"
                required
                value={transfer.productId}
                disabled={busy || loading}
                onChange={(event) =>
                  changeTransfer('productId', event.target.value)
                }
              >
                <option value="">Choose product</option>
                {products
                  .filter((product) => product.active)
                  .map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.sku} · {product.name} ({product.unitOfMeasure})
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor="transfer-source">Source warehouse</label>
              <select
                id="transfer-source"
                required
                value={transfer.sourceWarehouseId}
                disabled={busy || loading}
                onChange={(event) =>
                  changeTransfer('sourceWarehouseId', event.target.value)
                }
              >
                <option value="">Choose origin</option>
                {warehouses
                  .filter((warehouse) => warehouse.active)
                  .map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.code} · {warehouse.name}
                    </option>
                  ))}
              </select>
              <p className="field-help" role="status">
                Available in source:{' '}
                {available ??
                  'Select a product and origin, or refresh to check.'}{' '}
                {available
                  ? products.find(
                      (product) => product.id === transfer.productId,
                    )?.unitOfMeasure
                  : ''}
              </p>
            </div>
            <div>
              <label htmlFor="transfer-destination">
                Destination warehouse
              </label>
              <select
                id="transfer-destination"
                required
                value={transfer.destinationWarehouseId}
                disabled={busy || loading}
                onChange={(event) =>
                  changeTransfer('destinationWarehouseId', event.target.value)
                }
              >
                <option value="">Choose destination</option>
                {warehouses
                  .filter((warehouse) => warehouse.active)
                  .map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.code} · {warehouse.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor="transfer-quantity">Transfer quantity</label>
              <input
                id="transfer-quantity"
                type="text"
                inputMode="decimal"
                required
                pattern="[0-9]+(\.[0-9]{1,6})?"
                maxLength={21}
                value={transfer.quantity}
                disabled={busy || loading}
                onChange={(event) =>
                  changeTransfer('quantity', event.target.value)
                }
              />
              <p className="field-help">
                Positive quantity in the product's unit. Stock is checked again
                when recording.
              </p>
            </div>
          </div>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || loading}
          >
            {busy ? 'Recording…' : 'Transfer stock'}
          </button>
        </form>
      )}
      <div className="catalog-fields inventory-filters">
        <div>
          <label htmlFor="stock-search">Product search</label>
          <input
            id="stock-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or SKU"
          />
        </div>
        <div>
          <label htmlFor="stock-warehouse">Warehouse filter</label>
          <select
            id="stock-warehouse"
            disabled={busy}
            value={warehouseFilter}
            onChange={(event) => {
              setWarehouseFilter(event.target.value);
              setLoading(true);
              setError('');
            }}
          >
            <option value="">All warehouses</option>
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.code} · {warehouse.name}
                {warehouse.active ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </div>
      </div>
      {loading ? (
        <p role="status">Loading inventory…</p>
      ) : (
        <>
          <h3>Current stock</h3>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Scrollable table"
          >
            <table aria-label="Current stock">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Warehouse</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Unit</th>
                </tr>
              </thead>
              <tbody>
                {balances
                  .filter((balance) => matches(balance.product))
                  .map((balance) => (
                    <tr key={balance.id}>
                      <td>
                        {balance.product.sku} · {balance.product.name}
                      </td>
                      <td>
                        {balance.warehouse.code} · {balance.warehouse.name}
                      </td>
                      <td>{balance.quantity}</td>
                      <td>{balance.product.unitOfMeasure}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {balances.filter((balance) => matches(balance.product)).length ===
              0 && (
              <p className="empty-state">
                No stock balances match these filters. Products without a
                balance have zero stock.
              </p>
            )}
          </div>
          <div className="history-heading">
            <h3>Movement history</h3>
            <div>
              <label htmlFor="history-type">Movement type filter</label>
              <select
                id="history-type"
                disabled={busy}
                value={typeFilter}
                onChange={(event) => {
                  setTypeFilter(event.target.value);
                  setLoading(true);
                  setError('');
                }}
              >
                <option value="">All movement types</option>
                {Object.entries(historyTypes).map(([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Scrollable table"
          >
            <table aria-label="Movement history">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Product</th>
                  <th scope="col">Warehouse</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Time</th>
                  <th scope="col">Reference / correlation</th>
                </tr>
              </thead>
              <tbody>
                {movements
                  .filter((movement) => matches(movement.product))
                  .map((movement) => (
                    <tr key={movement.id}>
                      <td>
                        {historyTypes[
                          movement.type as keyof typeof historyTypes
                        ] ?? movement.type}
                      </td>
                      <td>
                        {movement.product.sku} · {movement.product.name}
                      </td>
                      <td>{movement.warehouse.code}</td>
                      <td>
                        {movement.quantity} {movement.product.unitOfMeasure}
                      </td>
                      <td>{movement.previousBalance}</td>
                      <td>{movement.resultingBalance}</td>
                      <td>{movement.actor.displayName}</td>
                      <td>
                        <time dateTime={movement.createdAt}>
                          {new Date(movement.createdAt).toLocaleString()}
                        </time>
                      </td>
                      <td>
                        {movement.referenceType && (
                          <>
                            {movement.referenceType}: {movement.referenceId}
                            <br />
                          </>
                        )}
                        {movement.transferId ?? movement.correlationId ?? '—'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {movements.filter((movement) => matches(movement.product))
              .length === 0 && (
              <p className="empty-state">No movements match these filters.</p>
            )}
          </div>
        </>
      )}
      <div className="catalog-actions">
        {(['balances', 'movements'] as const).map(
          (kind) =>
            pages[kind] != null && (
              <button
                key={kind}
                className="secondary-button"
                disabled={busy || loading}
                onClick={() => void more(kind)}
              >
                Load more {kind}
              </button>
            ),
        )}
      </div>
    </section>
  );
}
