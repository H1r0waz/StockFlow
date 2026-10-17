import { StatusBadge } from './StatusBadge';
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Supplier = {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  active: boolean;
};
type Product = {
  id: string;
  sku: string;
  name: string;
  active: boolean;
  unitOfMeasure: string;
};
type Warehouse = { id: string; code: string; name: string; active: boolean };
type PurchaseReceipt = {
  id: string;
  createdAt: string;
  warehouse: Pick<Warehouse, 'id' | 'code' | 'name'>;
  actor: { id: string; displayName: string };
  lines: {
    id: string;
    product: Product;
    receivedQuantity: string;
    inventoryMovement: { id: string; correlationKey: string };
  }[];
};
type PurchaseOrder = {
  id: string;
  status: 'DRAFT' | 'SENT' | 'CANCELLED' | 'PARTIALLY_RECEIVED' | 'RECEIVED';
  supplier: Supplier;
  creator: { id: string; displayName: string };
  createdAt: string;
  sentAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  notes: string | null;
  lines: {
    id: string;
    product: Product;
    orderedQuantity: string;
    receivedQuantity: string;
    pendingQuantity: string;
    cancelledQuantity: string;
  }[];
};
type SupplierFields = {
  name: string;
  legalName: string;
  taxId: string;
  email: string;
  phone: string;
  notes: string;
};
const emptySupplier: SupplierFields = {
  name: '',
  legalName: '',
  taxId: '',
  email: '',
  phone: '',
  notes: '',
};
type Draft = {
  id: string | null;
  supplierId: string;
  notes: string;
  lines: { key: string; productId: string; orderedQuantity: string }[];
};
const emptyLine = () => ({
  key: crypto.randomUUID(),
  productId: '',
  orderedQuantity: '',
});
class PurchasingError extends Error {
  constructor(public status: number) {
    super('Purchasing request failed');
  }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(30_000),
    ...init,
  });
  if (!response.ok) throw new PurchasingError(response.status);
  return response.json() as Promise<T>;
}

export function Purchasing({
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
  const base = `/api/organizations/${encodeURIComponent(organizationId)}`;
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);
  const [supplierEditor, setSupplierEditor] = useState<{
    id: string | null;
    fields: SupplierFields;
  } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reason, setReason] = useState('');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [receipts, setReceipts] = useState<PurchaseReceipt[]>([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false);
  const [receiptWarehouse, setReceiptWarehouse] = useState('');
  const [receiptQuantities, setReceiptQuantities] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [pages, setPages] = useState<Record<string, number | null>>({});
  const intent = useRef<{ path: string; body: string; key: string } | null>(
    null,
  );
  const detailRequest = useRef(0);
  const selectedId = selected?.id;
  const selectedStatus = selected?.status;
  const canReceive =
    selectedStatus === 'SENT' || selectedStatus === 'PARTIALLY_RECEIVED';

  useEffect(() => {
    let cancelled = false;
    setReceipts([]);
    setWarehouses([]);
    if (!selectedId || selectedStatus === 'DRAFT') return;
    setReceiptsLoading(true);
    Promise.all([
      request<{ receipts: PurchaseReceipt[]; nextOffset?: number | null }>(
        `${base}/purchase-orders/${selectedId}/receipts`,
      ),
      canEdit && canReceive
        ? request<{ warehouses: Warehouse[]; nextOffset?: number | null }>(
            `${base}/warehouses`,
          )
        : Promise.resolve({ warehouses: [], nextOffset: null }),
    ])
      .then(([history, destinations]) => {
        if (cancelled) return;
        setReceipts(history.receipts);
        setPages((old) => ({
          ...old,
          receipts: history.nextOffset ?? null,
          warehouses: destinations.nextOffset ?? null,
        }));
        setWarehouses(
          destinations.warehouses.filter((warehouse) => warehouse.active),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof PurchasingError && error.status === 401)
          onExpired();
        else
          setError(
            'Unable to load receipt history or warehouses. Refresh purchasing.',
          );
      })
      .finally(() => {
        if (!cancelled) setReceiptsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    base,
    selectedId,
    selectedStatus,
    canEdit,
    canReceive,
    reload,
    onExpired,
  ]);

  function failure(error: unknown, safeRetry = false) {
    if (error instanceof PurchasingError && error.status === 401) onExpired();
    else
      setError(
        error instanceof PurchasingError && error.status === 429
          ? 'Too many requests. Wait before trying again.'
          : error instanceof PurchasingError && error.status === 404
            ? 'This record is no longer available. Refresh purchasing and check the records.'
            : error instanceof PurchasingError && error.status === 409
              ? 'This operation conflicts with the current order, active records or a previous request. Refresh and check the details.'
              : error instanceof PurchasingError && error.status === 403
                ? 'You do not have permission to modify purchasing. Refresh your session.'
                : error instanceof PurchasingError && error.status === 400
                  ? 'Check the required fields, unique products and positive quantities in the product precision.'
                  : safeRetry
                    ? 'The result could not be confirmed. Retry the same values to safely check this request.'
                    : 'The result could not be confirmed. Refresh purchasing and check the records before retrying.',
      );
  }
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      request<{ suppliers: Supplier[]; nextOffset?: number | null }>(
        `${base}/suppliers`,
      ),
      request<{ products: Product[]; nextOffset?: number | null }>(
        `${base}/products`,
      ),
      request<{ purchaseOrders: PurchaseOrder[]; nextOffset?: number | null }>(
        `${base}/purchase-orders`,
      ),
    ])
      .then(([s, p, o]) => {
        if (cancelled) return;
        setSuppliers(s.suppliers);
        setProducts(p.products);
        setOrders(o.purchaseOrders);
        setPages((old) => ({
          ...old,
          suppliers: s.nextOffset ?? null,
          products: p.nextOffset ?? null,
          orders: o.nextOffset ?? null,
        }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof PurchasingError && error.status === 401)
          onExpired();
        else setError('Unable to load purchasing. Try refreshing.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, reload, onExpired]);

  async function more(
    kind: 'suppliers' | 'products' | 'orders' | 'warehouses' | 'receipts',
  ) {
    if (pages[kind] == null || busy) return;
    setBusy(true);
    setError('');
    const path =
      kind === 'orders'
        ? 'purchase-orders'
        : kind === 'receipts'
          ? `purchase-orders/${selectedId}/receipts`
          : kind;
    try {
      const data = await request<{
        suppliers?: Supplier[];
        products?: Product[];
        purchaseOrders?: PurchaseOrder[];
        warehouses?: Warehouse[];
        receipts?: PurchaseReceipt[];
        nextOffset?: number | null;
      }>(`${base}/${path}?offset=${pages[kind]}`);
      if (data.suppliers) setSuppliers((old) => [...old, ...data.suppliers!]);
      if (data.products) setProducts((old) => [...old, ...data.products!]);
      if (data.purchaseOrders)
        setOrders((old) => [...old, ...data.purchaseOrders!]);
      if (data.warehouses)
        setWarehouses((old) => [
          ...old,
          ...data.warehouses!.filter((w) => w.active),
        ]);
      if (data.receipts) setReceipts((old) => [...old, ...data.receipts!]);
      setPages((old) => ({ ...old, [kind]: data.nextOffset ?? null }));
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  }

  async function mutate<T>(
    path: string,
    method: string,
    payload: unknown,
    idempotent = false,
  ): Promise<T> {
    const body = JSON.stringify(payload);
    if (
      idempotent &&
      (!intent.current ||
        intent.current.path !== path ||
        intent.current.body !== body)
    )
      intent.current = { path, body, key: crypto.randomUUID() };
    const result = await request<T>(path, {
      method,
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        ...(idempotent && intent.current
          ? { 'Idempotency-Key': intent.current.key }
          : {}),
      },
    });
    if (idempotent) intent.current = null;
    return result;
  }
  function start() {
    setBusy(true);
    setError('');
    setNotice('');
  }
  async function saveSupplier(event: FormEvent) {
    event.preventDefault();
    if (!supplierEditor || busy) return;
    start();
    try {
      const { id, fields } = supplierEditor;
      await mutate(
        `${base}/suppliers${id ? `/${id}` : ''}`,
        id ? 'PATCH' : 'POST',
        {
          name: fields.name.trim(),
          ...Object.fromEntries(
            Object.entries(fields)
              .filter(([key]) => key !== 'name')
              .map(([key, value]) => [key, value.trim() || null]),
          ),
        },
      );
      setSupplierEditor(null);
      setNotice('Supplier saved.');
      setReload((value) => value + 1);
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  }
  async function toggleSupplier(supplier: Supplier) {
    if (busy) return;
    start();
    try {
      await mutate(`${base}/suppliers/${supplier.id}`, 'PATCH', {
        active: !supplier.active,
      });
      setNotice('Supplier availability updated.');
      setReload((value) => value + 1);
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  }
  async function showOrder(id: string) {
    const token = ++detailRequest.current;
    setError('');
    setDraft(null);
    setSelected(null);
    setReason('');
    setReceiptWarehouse('');
    setReceiptQuantities({});
    setBusy(true);
    try {
      const result = await request<{ purchaseOrder: PurchaseOrder }>(
        `${base}/purchase-orders/${id}`,
      );
      if (token === detailRequest.current) setSelected(result.purchaseOrder);
    } catch (error) {
      if (token === detailRequest.current) failure(error);
    } finally {
      if (token === detailRequest.current) setBusy(false);
    }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    const ids = draft.lines.map((line) => line.productId);
    if (new Set(ids).size !== ids.length) {
      setError('Choose each product only once.');
      return;
    }
    start();
    try {
      const { purchaseOrder } = await mutate<{ purchaseOrder: PurchaseOrder }>(
        `${base}/purchase-orders${draft.id ? `/${draft.id}` : ''}`,
        draft.id ? 'PATCH' : 'POST',
        {
          supplierId: draft.supplierId,
          notes: draft.notes.trim() || null,
          lines: draft.lines.map(({ productId, orderedQuantity }) => ({
            productId,
            orderedQuantity: orderedQuantity.trim(),
          })),
        },
        !draft.id,
      );
      setSelected(purchaseOrder);
      setDraft(null);
      setNotice('Draft saved.');
      setReload((value) => value + 1);
    } catch (error) {
      failure(error, !draft.id);
    } finally {
      setBusy(false);
    }
  }
  async function command(action: 'send' | 'cancel', event?: FormEvent) {
    event?.preventDefault();
    if (!selected || busy) return;
    start();
    try {
      const { purchaseOrder } = await mutate<{ purchaseOrder: PurchaseOrder }>(
        `${base}/purchase-orders/${selected.id}/${action}`,
        'POST',
        action === 'cancel' ? { reason: reason.trim() } : {},
        true,
      );
      setSelected(purchaseOrder);
      setReason('');
      setNotice(action === 'send' ? 'Order sent.' : 'Order cancelled.');
      setReload((value) => value + 1);
    } catch (error) {
      failure(error, true);
    } finally {
      setBusy(false);
    }
  }

  async function receive(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy || !canReceive || !canEdit) return;
    const lines = selected.lines.flatMap((line) => {
      const quantity = receiptQuantities[line.id]?.trim();
      return quantity ? [{ purchaseOrderLineId: line.id, quantity }] : [];
    });
    if (!lines.length) {
      setError('Enter a positive quantity for at least one pending line.');
      return;
    }
    start();
    try {
      const { purchaseOrder } = await mutate<{ purchaseOrder: PurchaseOrder }>(
        `${base}/purchase-orders/${selected.id}/receipts`,
        'POST',
        { warehouseId: receiptWarehouse, lines },
        true,
      );
      setSelected(purchaseOrder);
      setReceiptQuantities({});
      setNotice('Receipt recorded.');
      setReload((value) => value + 1);
    } catch (error) {
      failure(error, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="members-card" aria-labelledby="purchasing-title">
      <h2 id="purchasing-title">Purchasing</h2>
      <p className="muted">
        Suppliers and purchase orders.{' '}
        {canEdit
          ? 'Create drafts, send, receive and cancel orders.'
          : 'Read-only access.'}
      </p>
      <p className="field-help">
        Costs and totals are not captured yet. Orders use their unique ID.
        Receipts add stock to the selected warehouse.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="save-notice">
          {notice}
        </p>
      )}
      <button
        className="secondary-button"
        type="button"
        disabled={busy || loading}
        onClick={() => {
          setError('');
          setReload((value) => value + 1);
          if (selected) void showOrder(selected.id);
        }}
      >
        Refresh purchasing
      </button>
      {loading && <p role="status">Loading purchasing…</p>}
      <h3>Suppliers</h3>
      {canEdit && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy || loading}
          onClick={() => {
            setSupplierEditor({ id: null, fields: { ...emptySupplier } });
            setNotice('');
          }}
        >
          New supplier
        </button>
      )}
      {supplierEditor && (
        <form
          aria-label="Supplier editor"
          className="catalog-form"
          onSubmit={saveSupplier}
        >
          <h4>{supplierEditor.id ? 'Edit supplier' : 'Create supplier'}</h4>
          <div className="catalog-fields">
            {(Object.keys(emptySupplier) as (keyof SupplierFields)[]).map(
              (key) => (
                <div key={key}>
                  <label htmlFor={`supplier-${key}`}>
                    {
                      {
                        name: 'Supplier name',
                        legalName: 'Legal name',
                        taxId: 'Tax ID',
                        email: 'Supplier email',
                        phone: 'Phone',
                        notes: 'Supplier notes',
                      }[key]
                    }
                  </label>
                  <input
                    id={`supplier-${key}`}
                    value={supplierEditor.fields[key]}
                    type={key === 'email' ? 'email' : 'text'}
                    required={key === 'name'}
                    maxLength={
                      key === 'notes'
                        ? 2000
                        : key === 'email'
                          ? 254
                          : key === 'taxId' || key === 'phone'
                            ? 64
                            : 160
                    }
                    disabled={busy}
                    onChange={(event) =>
                      setSupplierEditor({
                        ...supplierEditor,
                        fields: {
                          ...supplierEditor.fields,
                          [key]: event.target.value,
                        },
                      })
                    }
                  />
                </div>
              ),
            )}
          </div>
          <button className="primary-button" type="submit" disabled={busy}>
            Save supplier
          </button>{' '}
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => setSupplierEditor(null)}
          >
            Close supplier editor
          </button>
        </form>
      )}
      {!loading && (
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Scrollable table"
        >
          <table aria-label="Suppliers">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Contact</th>
                <th scope="col">Status</th>
                {canEdit && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {suppliers.map((supplier) => (
                <tr key={supplier.id}>
                  <td>
                    {supplier.name}
                    <br />
                    {supplier.legalName}
                    {supplier.taxId && <small> · {supplier.taxId}</small>}
                  </td>
                  <td>
                    {supplier.email ?? '—'}
                    <br />
                    {supplier.phone}
                  </td>
                  <td>
                    <StatusBadge
                      status={supplier.active ? 'Active' : 'Inactive'}
                    />
                  </td>
                  {canEdit && (
                    <td>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busy}
                        aria-label={`Edit supplier ${supplier.name}`}
                        onClick={() =>
                          setSupplierEditor({
                            id: supplier.id,
                            fields: Object.fromEntries(
                              Object.keys(emptySupplier).map((key) => [
                                key,
                                supplier[key as keyof SupplierFields] ?? '',
                              ]),
                            ) as SupplierFields,
                          })
                        }
                      >
                        Edit
                      </button>{' '}
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busy}
                        aria-label={`${supplier.active ? 'Deactivate' : 'Activate'} supplier ${supplier.name}`}
                        onClick={() => void toggleSupplier(supplier)}
                      >
                        {supplier.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {suppliers.length === 0 && (
            <p className="empty-state">
              No suppliers yet. Add a supplier before creating a purchase order.
            </p>
          )}
        </div>
      )}
      <div className="catalog-actions">
        {(['suppliers', 'products', 'orders'] as const).map(
          (kind) =>
            pages[kind] != null && (
              <button
                key={kind}
                type="button"
                className="secondary-button"
                disabled={busy || loading}
                onClick={() => void more(kind)}
              >
                Load more {kind === 'orders' ? 'purchase orders' : kind}
              </button>
            ),
        )}
      </div>
      <h3>Purchase orders</h3>
      {canEdit && (
        <button
          className="secondary-button"
          type="button"
          disabled={busy || loading}
          onClick={() => {
            setDraft({
              id: null,
              supplierId: '',
              notes: '',
              lines: [emptyLine()],
            });
            setSelected(null);
            setNotice('');
          }}
        >
          New purchase order
        </button>
      )}
      {draft && (
        <form
          aria-label="Purchase order editor"
          className="catalog-form"
          onSubmit={saveDraft}
        >
          <h4>{draft.id ? 'Edit draft' : 'Create draft'}</h4>
          <label htmlFor="order-supplier">Order supplier</label>
          <select
            id="order-supplier"
            required
            value={draft.supplierId}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, supplierId: event.target.value })
            }
          >
            <option value="">Choose supplier</option>
            {suppliers
              .filter(
                (supplier) =>
                  supplier.active || supplier.id === draft.supplierId,
              )
              .map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                  {supplier.active ? '' : ' (inactive)'}
                </option>
              ))}
          </select>
          <label htmlFor="order-notes">Order notes</label>
          <input
            id="order-notes"
            value={draft.notes}
            maxLength={2000}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, notes: event.target.value })
            }
          />
          {draft.lines.map((line, index) => (
            <fieldset key={line.key} disabled={busy}>
              <legend>Order line {index + 1}</legend>
              <label htmlFor={`line-product-${line.key}`}>
                Line {index + 1} product
              </label>
              <select
                id={`line-product-${line.key}`}
                required
                value={line.productId}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    lines: draft.lines.map((item) =>
                      item.key === line.key
                        ? { ...item, productId: event.target.value }
                        : item,
                    ),
                  })
                }
              >
                <option value="">Choose product</option>
                {products
                  .filter(
                    (product) =>
                      product.active || product.id === line.productId,
                  )
                  .map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.sku} · {product.name} ({product.unitOfMeasure})
                      {product.active ? '' : ' (inactive)'}
                    </option>
                  ))}
              </select>
              <label htmlFor={`line-quantity-${line.key}`}>
                Line {index + 1} quantity
              </label>
              <input
                id={`line-quantity-${line.key}`}
                type="text"
                inputMode="decimal"
                pattern="[0-9]+(\.[0-9]{1,6})?"
                maxLength={21}
                required
                value={line.orderedQuantity}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    lines: draft.lines.map((item) =>
                      item.key === line.key
                        ? { ...item, orderedQuantity: event.target.value }
                        : item,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="secondary-button"
                disabled={draft.lines.length === 1}
                aria-label={`Remove line ${index + 1}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    lines: draft.lines.filter((item) => item.key !== line.key),
                  })
                }
              >
                Remove line
              </button>
            </fieldset>
          ))}
          <p className="field-help">
            Use each product once and a positive decimal quantity in its unit
            and allowed precision.
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || draft.lines.length >= 100}
            onClick={() =>
              setDraft({ ...draft, lines: [...draft.lines, emptyLine()] })
            }
          >
            Add order line
          </button>{' '}
          <button type="submit" className="primary-button" disabled={busy}>
            Save draft
          </button>{' '}
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => setDraft(null)}
          >
            Close order editor
          </button>
        </form>
      )}
      {!loading && (
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Scrollable table"
        >
          <table aria-label="Purchase orders">
            <thead>
              <tr>
                <th scope="col">Order ID</th>
                <th scope="col">Supplier</th>
                <th scope="col">Status</th>
                <th scope="col">Date</th>
                <th scope="col">Creator</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>{order.id}</td>
                  <td>{order.supplier.name}</td>
                  <td>
                    <StatusBadge status={order.status} />
                  </td>
                  <td>{new Date(order.createdAt).toLocaleString()}</td>
                  <td>{order.creator.displayName}</td>
                  <td>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      aria-label={`View order ${order.id}`}
                      onClick={() => void showOrder(order.id)}
                    >
                      View order
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {orders.length === 0 && (
            <p className="empty-state">
              No purchase orders yet. Create a draft to plan your next delivery.
            </p>
          )}
        </div>
      )}
      {selected && !draft && (
        <section aria-label="Purchase order detail" className="catalog-form">
          <h3>Order {selected.id}</h3>
          <p>Supplier: {selected.supplier.name}</p>
          <p>
            Order status: <StatusBadge status={selected.status} />
          </p>
          <p>
            Created by {selected.creator.displayName} ·{' '}
            <time dateTime={selected.createdAt}>
              {new Date(selected.createdAt).toLocaleString()}
            </time>
          </p>
          {selected.notes && <p>Notes: {selected.notes}</p>}
          {selected.sentAt && (
            <p>Sent: {new Date(selected.sentAt).toLocaleString()}</p>
          )}
          {selected.cancelledAt && (
            <p>Cancelled: {new Date(selected.cancelledAt).toLocaleString()}</p>
          )}
          {selected.cancellationReason && (
            <p>Cancellation reason: {selected.cancellationReason}</p>
          )}
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Scrollable table"
          >
            <table aria-label="Order lines">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Ordered quantity</th>
                  <th scope="col">Received quantity</th>
                  <th scope="col">Pending quantity</th>
                  {selected.status === 'CANCELLED' && (
                    <th scope="col">Cancelled quantity</th>
                  )}
                  <th scope="col">Unit</th>
                </tr>
              </thead>
              <tbody>
                {selected.lines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      {line.product.sku} · {line.product.name}
                    </td>
                    <td>{line.orderedQuantity}</td>
                    <td>{line.receivedQuantity}</td>
                    <td>{line.pendingQuantity}</td>
                    {selected.status === 'CANCELLED' && (
                      <td>{line.cancelledQuantity}</td>
                    )}
                    <td>{line.product.unitOfMeasure}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit && canReceive && (
            <form
              aria-label="Receive purchase order"
              onSubmit={(event) => void receive(event)}
            >
              <h4>Receive goods</h4>
              <label htmlFor="receipt-warehouse">Receipt warehouse</label>
              <select
                id="receipt-warehouse"
                required
                value={receiptWarehouse}
                disabled={busy || receiptsLoading}
                onChange={(event) => setReceiptWarehouse(event.target.value)}
              >
                <option value="">Choose warehouse</option>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.code} · {warehouse.name}
                  </option>
                ))}
              </select>
              {pages.warehouses != null && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void more('warehouses')}
                >
                  Load more receipt warehouses
                </button>
              )}
              <p className="field-help">
                Leave lines blank to receive them later. Quantities must be
                positive, within the pending amount and product precision.
              </p>
              {selected.lines.map(
                (line, index) =>
                  line.pendingQuantity !== '0.000000' && (
                    <div key={line.id}>
                      <label htmlFor={`receipt-line-${line.id}`}>
                        Receive line {index + 1} quantity
                      </label>
                      <p className="field-help">
                        {line.product.sku} · {line.product.name} · Pending:{' '}
                        {line.pendingQuantity} {line.product.unitOfMeasure}
                      </p>
                      <input
                        id={`receipt-line-${line.id}`}
                        type="text"
                        inputMode="decimal"
                        pattern="[0-9]+(\.[0-9]{1,6})?"
                        maxLength={21}
                        value={receiptQuantities[line.id] ?? ''}
                        disabled={busy || receiptsLoading}
                        onChange={(event) =>
                          setReceiptQuantities({
                            ...receiptQuantities,
                            [line.id]: event.target.value,
                          })
                        }
                      />
                    </div>
                  ),
              )}
              <button
                className="primary-button"
                type="submit"
                disabled={busy || receiptsLoading || warehouses.length === 0}
              >
                Record receipt
              </button>
            </form>
          )}
          {selected.status !== 'DRAFT' && (
            <>
              <h4>Receipt history</h4>
              {pages.receipts != null && (
                <button
                  type="button"
                  disabled={busy || receiptsLoading}
                  onClick={() => void more('receipts')}
                >
                  Load more receipts
                </button>
              )}
              {receiptsLoading && <p role="status">Loading receipts…</p>}
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Scrollable table"
              >
                <table aria-label="Purchase receipts">
                  <thead>
                    <tr>
                      <th scope="col">Receipt / date</th>
                      <th scope="col">Warehouse</th>
                      <th scope="col">Actor</th>
                      <th scope="col">Received lines / ledger</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipts.map((receipt) => (
                      <tr key={receipt.id}>
                        <td>
                          {receipt.id}
                          <br />
                          <time dateTime={receipt.createdAt}>
                            {new Date(receipt.createdAt).toLocaleString()}
                          </time>
                        </td>
                        <td>
                          {receipt.warehouse.code} · {receipt.warehouse.name}
                        </td>
                        <td>{receipt.actor.displayName}</td>
                        <td>
                          {receipt.lines.map((line) => (
                            <p key={line.id}>
                              {line.product.sku} · {line.product.name}:{' '}
                              {line.receivedQuantity}{' '}
                              {line.product.unitOfMeasure}
                              <br />
                              <small>
                                Movement: {line.inventoryMovement.id} ·
                                Correlation:{' '}
                                {line.inventoryMovement.correlationKey}
                              </small>
                            </p>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!receiptsLoading && receipts.length === 0 && (
                  <p className="empty-state">
                    No receipts yet. Received deliveries will appear here with
                    their quantities and destination.
                  </p>
                )}
              </div>
            </>
          )}
          {selected.status !== 'DRAFT' && (
            <p className="field-help">
              Supplier and lines are locked after sending or cancellation.
            </p>
          )}
          {canEdit && selected.status === 'DRAFT' && (
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() =>
                  setDraft({
                    id: selected.id,
                    supplierId: selected.supplier.id,
                    notes: selected.notes ?? '',
                    lines: selected.lines.map((line) => ({
                      key: crypto.randomUUID(),
                      productId: line.product.id,
                      orderedQuantity: line.orderedQuantity,
                    })),
                  })
                }
              >
                Edit draft
              </button>{' '}
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() => void command('send')}
              >
                Send order
              </button>
            </>
          )}
          {canEdit &&
            (selected.status === 'DRAFT' ||
              selected.status === 'SENT' ||
              selected.status === 'PARTIALLY_RECEIVED') && (
              <form
                aria-label="Cancel purchase order"
                onSubmit={(event) => void command('cancel', event)}
              >
                <label htmlFor="order-cancel-reason">Cancellation reason</label>
                <input
                  id="order-cancel-reason"
                  value={reason}
                  required
                  maxLength={500}
                  disabled={busy}
                  onChange={(event) => setReason(event.target.value)}
                />
                <button
                  className="secondary-button"
                  type="submit"
                  disabled={busy}
                >
                  Cancel order
                </button>
              </form>
            )}
        </section>
      )}
    </section>
  );
}
