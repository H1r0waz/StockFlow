import { StatusBadge, readableLabel } from './StatusBadge';
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Product = {
  id: string;
  sku: string;
  name: string;
  active?: boolean;
  unitOfMeasure: string;
};
type Warehouse = { id: string; code: string; name: string; active?: boolean };
type Event = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  correlationKey: string | null;
  createdAt: string;
  actor: { displayName: string } | null;
};
type Alert = {
  id: string;
  quantity: string;
  minimumQuantity: string;
  status: string;
  product: Product;
  warehouse: Warehouse;
};
type Dashboard = {
  activeProducts: number;
  activeWarehouses: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  purchaseOrders: {
    DRAFT: number;
    SENT: number;
    PARTIALLY_RECEIVED: number;
    recentReceived: number;
  };
  recentMovements: {
    id: string;
    type: string;
    quantity: string;
    createdAt: string;
    product?: Product;
  }[];
  recentReceipts: { id: string; createdAt: string }[];
};
type Page = { hasMore?: boolean; nextOffset?: number | null };
class OperationsError extends Error {
  constructor(public status: number) {
    super('Request failed');
  }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(30_000),
    ...init,
  });
  if (!response.ok) throw new OperationsError(response.status);
  return response.json() as Promise<T>;
}
export function Operations({
  view,
  organizationId,
  csrfToken,
  canEdit,
  onExpired,
  navigate,
}: {
  view: 'dashboard' | 'alerts' | 'audit';
  organizationId: string;
  csrfToken: string;
  canEdit: boolean;
  onExpired: () => void;
  navigate: (section: 'inventory' | 'purchasing' | 'alerts') => void;
}) {
  const base = `/api/organizations/${encodeURIComponent(organizationId)}`;
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [critical, setCritical] = useState<Alert[]>([]);
  const [criticalLoading, setCriticalLoading] = useState(false);
  const [criticalError, setCriticalError] = useState(false);
  const [rows, setRows] = useState<(Alert | Event)[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [filters, setFilters] = useState({
    status: '',
    action: '',
    entityType: '',
    entityId: '',
    actorId: '',
    from: '',
    to: '',
  });
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [productNext, setProductNext] = useState<number | null>(null);
  const [warehouseNext, setWarehouseNext] = useState<number | null>(null);
  const [threshold, setThreshold] = useState({
    productId: '',
    warehouseId: '',
    minimumQuantity: '',
  });
  const [notice, setNotice] = useState('');
  function fail(failure: unknown) {
    if (failure instanceof OperationsError && failure.status === 401)
      onExpired();
    else
      setError(
        failure instanceof OperationsError && failure.status === 429
          ? 'Too many requests. Wait before trying again.'
          : failure instanceof OperationsError && failure.status === 404
            ? 'This record is no longer available. Reload the view.'
            : failure instanceof OperationsError && failure.status === 403
              ? 'You do not have permission to access this operation.'
              : 'Unable to complete the operation. Check the values and retry.',
      );
  }
  const query = new URLSearchParams(
    Object.entries(filters)
      .filter(([, value]) => value)
      .map(([key, value]) => [
        key,
        key === 'from' || key === 'to' ? new Date(value).toISOString() : value,
      ]),
  ).toString();
  const requestIdentity = `${base}/${view}?${query}`;
  const identity = useRef(requestIdentity);
  identity.current = requestIdentity;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setRows([]);
    setNext(null);
    if (view === 'audit' && !canEdit) {
      setLoading(false);
      return;
    }
    const path =
      view === 'dashboard'
        ? `${base}/dashboard`
        : `${base}/${view === 'alerts' ? 'inventory/alerts' : 'audit'}?${query}`;
    request<
      { dashboard?: Dashboard; alerts?: Alert[]; events?: Event[] } & Page
    >(path)
      .then((data) => {
        if (cancelled) return;
        if (data.dashboard) setDashboard(data.dashboard);
        setRows(data.alerts ?? data.events ?? []);
        setNext(data.nextOffset ?? null);
      })
      .catch((failure) => {
        if (!cancelled) fail(failure);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // The request identity includes all filters and tenant; ignore stale responses after navigation.
  }, [base, view, query, reload, canEdit, onExpired]);
  useEffect(() => {
    if (view !== 'dashboard') return;
    let cancelled = false;
    setCritical([]);
    setCriticalLoading(true);
    setCriticalError(false);
    Promise.all(
      ['OUT_OF_STOCK', 'LOW'].map((status) =>
        request<{ alerts?: Alert[] }>(
          `${base}/inventory/alerts?status=${status}&limit=3`,
        ),
      ),
    )
      .then((pages) => {
        if (!cancelled) setCritical(pages.flatMap((page) => page.alerts ?? []));
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        if (failure instanceof OperationsError && failure.status === 401)
          onExpired();
        else setCriticalError(true);
      })
      .finally(() => {
        if (!cancelled) setCriticalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, view, reload, onExpired]);
  useEffect(() => {
    if (view !== 'alerts' || !canEdit) return;
    let cancelled = false;
    Promise.all([
      request<{ products: Product[] } & Page>(`${base}/products`),
      request<{ warehouses: Warehouse[] } & Page>(`${base}/warehouses`),
    ])
      .then(([p, w]) => {
        if (!cancelled) {
          setProducts(p.products);
          setWarehouses(w.warehouses);
          setProductNext(p.nextOffset ?? null);
          setWarehouseNext(w.nextOffset ?? null);
        }
      })
      .catch((failure) => {
        if (!cancelled) fail(failure);
      });
    return () => {
      cancelled = true;
    };
  }, [base, view, canEdit, onExpired]);
  async function more() {
    if (next === null || loading) return;
    setLoading(true);
    setError('');
    const expectedIdentity = requestIdentity;
    try {
      const data = await request<{ alerts?: Alert[]; events?: Event[] } & Page>(
        `${base}/${view === 'alerts' ? 'inventory/alerts' : 'audit'}?${query}&offset=${next}`,
      );
      if (identity.current !== expectedIdentity) return;
      setRows((old) => [...old, ...(data.alerts ?? data.events ?? [])]);
      setNext(data.nextOffset ?? null);
    } catch (failure) {
      if (identity.current === expectedIdentity) fail(failure);
    } finally {
      if (identity.current === expectedIdentity) setLoading(false);
    }
  }
  async function moreChoices(kind: 'products' | 'warehouses') {
    setLoading(true);
    try {
      const offset = kind === 'products' ? productNext : warehouseNext;
      const data = await request<
        { products?: Product[]; warehouses?: Warehouse[] } & Page
      >(`${base}/${kind}?offset=${offset}`);
      if (kind === 'products') {
        setProducts((old) => [...old, ...(data.products ?? [])]);
        setProductNext(data.nextOffset ?? null);
      } else {
        setWarehouses((old) => [...old, ...(data.warehouses ?? [])]);
        setWarehouseNext(data.nextOffset ?? null);
      }
    } catch (failure) {
      fail(failure);
    } finally {
      setLoading(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      await request(`${base}/inventory/thresholds`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(threshold),
      });
      setNotice('Minimum stock saved.');
      setReload((value) => value + 1);
    } catch (failure) {
      fail(failure);
    } finally {
      setLoading(false);
    }
  }
  return (
    <section
      className="members-card"
      aria-label={
        view === 'dashboard'
          ? 'Operational dashboard'
          : view === 'alerts'
            ? 'Stock alerts'
            : 'Business audit'
      }
    >
      <div className="catalog-heading">
        <h2>
          {view === 'dashboard'
            ? 'Operational dashboard'
            : view === 'alerts'
              ? 'Stock alerts'
              : 'Business audit'}
        </h2>
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          Refresh {view}
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Loading {view}…</p>}
      {view === 'dashboard' && dashboard && (
        <>
          <div className="catalog-fields dashboard-metrics">
            {Object.entries({
              'Active products': dashboard.activeProducts,
              'Active warehouses': dashboard.activeWarehouses,
              'Low stock products': dashboard.lowStockProducts,
              'Out of stock products': dashboard.outOfStockProducts,
              'Draft orders': dashboard.purchaseOrders.DRAFT,
              'Sent orders': dashboard.purchaseOrders.SENT,
              'Partially received orders':
                dashboard.purchaseOrders.PARTIALLY_RECEIVED,
              'Received orders · last 30 days':
                dashboard.purchaseOrders.recentReceived,
            }).map(([label, value]) => (
              <article key={label} className="catalog-form">
                <h3>{label}</h3>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
          <p className="field-help">
            Low stock counts products with a configured warehouse minimum. Out
            of stock includes active products with no positive stock in active
            warehouses.
          </p>
          <div className="catalog-actions">
            <button
              className="secondary-button"
              onClick={() => navigate('inventory')}
            >
              Open inventory
            </button>
            <button
              className="secondary-button"
              onClick={() => navigate('purchasing')}
            >
              Open purchase orders
            </button>
            <button
              className="secondary-button"
              onClick={() => navigate('alerts')}
            >
              Review critical inventory
            </button>
          </div>
          <section
            className="dashboard-attention"
            aria-labelledby="critical-heading"
          >
            <h3 id="critical-heading">Critical inventory</h3>
            <p className="muted">
              A snapshot of configured warehouse alerts: up to three
              out-of-stock and three low-stock items. Open alerts for the
              complete list.
            </p>
            {criticalLoading && (
              <p role="status">Loading critical inventory…</p>
            )}
            {criticalError && (
              <p role="alert">
                Critical inventory could not be loaded. Refresh the dashboard to
                try again.
              </p>
            )}
            {!criticalLoading && !criticalError && critical.length === 0 && (
              <p>
                No critical alerts among configured stock minimums. Review stock
                alerts to set minimum quantities.
              </p>
            )}
            <ul className="activity-list">
              {critical.map((alert) => (
                <li key={alert.id}>
                  <div>
                    <strong>{alert.product.name}</strong>
                    <span className="muted">
                      {alert.product.sku} · {alert.warehouse.name}
                    </span>
                  </div>
                  <div>
                    {alert.quantity} {alert.product.unitOfMeasure}
                    <span className="muted">
                      Minimum {alert.minimumQuantity}
                    </span>
                  </div>
                  <StatusBadge status={alert.status} />
                </li>
              ))}
            </ul>
          </section>
          <div className="dashboard-activity">
            <section>
              <h3>Recent movements</h3>
              {dashboard.recentMovements.length === 0 && (
                <p>
                  No movements yet. Record stock received or issued to start
                  your inventory history.
                </p>
              )}
              <ul className="activity-list">
                {dashboard.recentMovements.map((m) => (
                  <li key={m.id}>
                    <div>
                      <strong>{m.product?.name ?? 'Inventory movement'}</strong>
                      <span className="muted">
                        {readableLabel(m.type)} · {m.quantity}{' '}
                        {m.product?.unitOfMeasure}
                      </span>
                    </div>{' '}
                    <time dateTime={m.createdAt}>
                      {new Date(m.createdAt).toLocaleString()}
                    </time>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3>Recent receipts</h3>
              {dashboard.recentReceipts.length === 0 && (
                <p>
                  No receipts yet. Deliveries received against purchase orders
                  will appear here.
                </p>
              )}
              <ul className="activity-list">
                {dashboard.recentReceipts.map((r) => (
                  <li key={r.id}>
                    <div>
                      <strong>Purchase receipt</strong>
                      <details>
                        <summary>Receipt reference</summary>
                        <code>{r.id}</code>
                      </details>
                    </div>{' '}
                    <time dateTime={r.createdAt}>
                      {new Date(r.createdAt).toLocaleString()}
                    </time>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
      {view === 'alerts' && (
        <>
          <p>
            Minimum stock is configured per product and warehouse. Zero or
            missing balance is OUT_OF_STOCK; a positive quantity below minimum
            is LOW; equality is OK. Inactive products and warehouses are
            excluded.
          </p>
          {canEdit && (
            <form
              className="catalog-form"
              aria-label="Configure minimum stock"
              onSubmit={(event) => void save(event)}
            >
              <h3>Configure minimum stock</h3>
              <div className="catalog-fields">
                <div>
                  <label htmlFor="minimum-product">Minimum stock product</label>
                  <select
                    id="minimum-product"
                    required
                    value={threshold.productId}
                    disabled={loading}
                    onChange={(event) =>
                      setThreshold({
                        ...threshold,
                        productId: event.target.value,
                      })
                    }
                  >
                    <option value="">Choose product</option>
                    {products
                      .filter((p) => p.active)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} · {p.name} ({p.unitOfMeasure})
                        </option>
                      ))}
                  </select>
                  {productNext !== null && (
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void moreChoices('products')}
                    >
                      Load more threshold products
                    </button>
                  )}
                </div>
                <div>
                  <label htmlFor="minimum-warehouse">
                    Minimum stock warehouse
                  </label>
                  <select
                    id="minimum-warehouse"
                    required
                    value={threshold.warehouseId}
                    disabled={loading}
                    onChange={(event) =>
                      setThreshold({
                        ...threshold,
                        warehouseId: event.target.value,
                      })
                    }
                  >
                    <option value="">Choose warehouse</option>
                    {warehouses
                      .filter((w) => w.active)
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.code} · {w.name}
                        </option>
                      ))}
                  </select>
                  {warehouseNext !== null && (
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void moreChoices('warehouses')}
                    >
                      Load more threshold warehouses
                    </button>
                  )}
                </div>
                <div>
                  <label htmlFor="minimum-quantity">Minimum quantity</label>
                  <input
                    id="minimum-quantity"
                    type="text"
                    inputMode="decimal"
                    required
                    maxLength={21}
                    pattern="[0-9]+(\.[0-9]{1,6})?"
                    value={threshold.minimumQuantity}
                    disabled={loading}
                    onChange={(event) =>
                      setThreshold({
                        ...threshold,
                        minimumQuantity: event.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <button className="primary-button" disabled={loading}>
                Save minimum stock
              </button>
            </form>
          )}
          <label htmlFor="alert-status">Alert status</label>
          <select
            id="alert-status"
            value={filters.status}
            onChange={(event) =>
              setFilters({ ...filters, status: event.target.value })
            }
          >
            <option value="">All configured states</option>
            {['OK', 'LOW', 'OUT_OF_STOCK'].map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Scrollable table"
          >
            <table aria-label="Stock alerts">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Warehouse</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Minimum</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {(rows as Alert[]).map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.product.sku} · {row.product.name}
                    </td>
                    <td>
                      {row.warehouse.code} · {row.warehouse.name}
                    </td>
                    <td>
                      {row.quantity} {row.product.unitOfMeasure}
                    </td>
                    <td>{row.minimumQuantity}</td>
                    <td>
                      <StatusBadge status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && rows.length === 0 && (
            <p>No configured stock alerts match these filters.</p>
          )}
        </>
      )}
      {view === 'audit' &&
        (canEdit ? (
          <>
            <p>
              Follow who changed stock, purchases and workspace records. History
              cannot be edited. Use action codes or record references to narrow
              the results; dates use your local timezone.
            </p>
            <div className="catalog-fields">
              {(
                [
                  'action',
                  'entityType',
                  'entityId',
                  'actorId',
                  'from',
                  'to',
                ] as const
              ).map((key) => (
                <div key={key}>
                  <label htmlFor={`audit-${key}`}>
                    {
                      {
                        action: 'Action code',
                        entityType: 'Record type',
                        entityId: 'Record ID',
                        actorId: 'Team member ID',
                        from: 'From date',
                        to: 'To date',
                      }[key]
                    }
                  </label>
                  <input
                    id={`audit-${key}`}
                    aria-label={`Audit ${key}`}
                    type={
                      key === 'from' || key === 'to' ? 'datetime-local' : 'text'
                    }
                    value={filters[key]}
                    onChange={(event) =>
                      setFilters({ ...filters, [key]: event.target.value })
                    }
                  />
                </div>
              ))}
            </div>
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Scrollable table"
            >
              <table aria-label="Audit events">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Action</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Correlation</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows as Event[]).map((row) => (
                    <tr key={row.id}>
                      <td>
                        <time dateTime={row.createdAt}>
                          {new Date(row.createdAt).toLocaleString()}
                        </time>
                      </td>
                      <td>{row.actor?.displayName ?? 'System'}</td>
                      <td>
                        <strong>
                          {(
                            {
                              CREATE: 'Record created',
                              UPDATE: 'Record updated',
                              ACTIVATE: 'Record activated',
                              DEACTIVATE: 'Record deactivated',
                              RECEIPT: 'Stock received',
                              ISSUE: 'Stock issued',
                              ADJUSTMENT_IN: 'Stock increased',
                              ADJUSTMENT_OUT: 'Stock decreased',
                              TRANSFER: 'Stock transferred',
                              PURCHASE_RECEIPT: 'Purchase delivery received',
                              SEND: 'Order sent',
                              CANCEL: 'Order cancelled',
                              IMPORT: 'CSV imported',
                            } as Record<string, string>
                          )[row.action] ?? readableLabel(row.action)}
                        </strong>
                        <details>
                          <summary>Action code</summary>
                          <code>{row.action}</code>
                        </details>
                      </td>
                      <td>
                        {readableLabel(row.entityType)}
                        <details>
                          <summary>Record reference</summary>
                          <code>
                            {row.entityType} · {row.entityId}
                          </code>
                        </details>
                      </td>
                      <td>
                        {row.correlationKey ? (
                          <details>
                            <summary>Operation reference</summary>
                            <code>{row.correlationKey}</code>
                          </details>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!loading && rows.length === 0 && (
              <p>No audit events match these filters.</p>
            )}
          </>
        ) : (
          <p>Audit access requires OWNER or ADMIN.</p>
        ))}
      {view !== 'dashboard' && next !== null && (
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => void more()}
        >
          Load more {view === 'audit' ? 'audit events' : 'alerts'}
        </button>
      )}
    </section>
  );
}
