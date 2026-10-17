import { StatusBadge } from './StatusBadge';
import { useEffect, useState, type FormEvent } from 'react';

type Kind = 'categories' | 'products' | 'warehouses';
type Item = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  sku?: string;
  code?: string;
  categoryId?: string | null;
  unitOfMeasure?: string;
  quantityScale?: number;
};
type Fields = {
  name: string;
  description: string;
  identifier: string;
  categoryId: string;
  unitOfMeasure: string;
  quantityScale: string;
};
const empty: Fields = {
  name: '',
  description: '',
  identifier: '',
  categoryId: '',
  unitOfMeasure: 'UNIT',
  quantityScale: '0',
};
const labels = {
  categories: 'category',
  products: 'product',
  warehouses: 'warehouse',
};
const titles = {
  categories: 'Categories',
  products: 'Products',
  warehouses: 'Warehouses',
};

class CatalogError extends Error {
  constructor(public status: number) {
    super('Catalog request failed');
  }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(30_000),
    ...init,
  });
  if (!response.ok) throw new CatalogError(response.status);
  return response.json() as Promise<T>;
}

export function Catalog({
  kind,
  organizationId,
  csrfToken,
  canEdit,
  onExpired,
}: {
  kind: Kind;
  organizationId: string;
  csrfToken: string;
  canEdit: boolean;
  onExpired: () => void;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [categoryNext, setCategoryNext] = useState<number | null>(null);
  const [categories, setCategories] = useState<Item[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<{ id: string | null } | null>(null);
  const [fields, setFields] = useState<Fields>(empty);
  const [notice, setNotice] = useState('');
  const base = `/api/organizations/${encodeURIComponent(organizationId)}`;
  const label = labels[kind];
  const originalCategoryId = items?.find(
    (item) => item.id === editor?.id,
  )?.categoryId;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      request<Record<Kind, Item[]> & { nextOffset?: number | null }>(
        `${base}/${kind}`,
      ),
      kind === 'products'
        ? request<{ categories: Item[]; nextOffset?: number | null }>(
            `${base}/categories`,
          )
        : Promise.resolve({ categories: [], nextOffset: null }),
    ])
      .then(([data, categoryData]) => {
        if (!cancelled) {
          setItems(data[kind]);
          setNextOffset(data.nextOffset ?? null);
          setCategoryNext(categoryData.nextOffset ?? null);
          setCategories(categoryData.categories);
        }
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        if (failure instanceof CatalogError && failure.status === 401)
          onExpired();
        else setError(`Unable to load ${kind}. Please try again.`);
      });
    return () => {
      cancelled = true;
    };
  }, [base, kind, reload, onExpired]);

  async function more(categoryChoices = false) {
    setBusy(true);
    setError('');
    try {
      const data = await request<
        Record<Kind, Item[]> & { nextOffset?: number | null }
      >(
        `${base}/${categoryChoices ? 'categories' : kind}?offset=${categoryChoices ? categoryNext : nextOffset}`,
      );
      if (categoryChoices) {
        setCategories((old) => [...old, ...data.categories]);
        setCategoryNext(data.nextOffset ?? null);
      } else {
        setItems((old) => [...(old ?? []), ...data[kind]]);
        setNextOffset(data.nextOffset ?? null);
      }
    } catch (failure) {
      if (failure instanceof CatalogError && failure.status === 401)
        onExpired();
      else setError('Unable to load more records. Please retry.');
    } finally {
      setBusy(false);
    }
  }

  function open(item?: Item) {
    setError('');
    setNotice('');
    setEditor({ id: item?.id ?? null });
    setFields(
      item
        ? {
            name: item.name,
            description: item.description ?? '',
            identifier: item.sku ?? item.code ?? '',
            categoryId: item.categoryId ?? '',
            unitOfMeasure: item.unitOfMeasure ?? 'UNIT',
            quantityScale: String(item.quantityScale ?? 0),
          }
        : empty,
    );
  }
  function field(key: keyof Fields, value: string) {
    setFields((previous) => ({ ...previous, [key]: value }));
  }
  async function write(
    payload: Record<string, unknown>,
    id: string | null,
    closeEditor: boolean,
  ) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(
        `${base}/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`,
        {
          method: id ? 'PATCH' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify(payload),
        },
      );
      if (closeEditor) setEditor(null);
      setNotice('Changes saved.');
      setReload((value) => value + 1);
    } catch (failure) {
      if (failure instanceof CatalogError && failure.status === 401)
        onExpired();
      else
        setError(
          failure instanceof CatalogError && failure.status === 409
            ? 'A record with this name or identifier already exists, or the change conflicts with its current use.'
            : failure instanceof CatalogError && failure.status === 403
              ? 'You do not have permission to make this change. Refresh your session.'
              : failure instanceof CatalogError && failure.status === 404
                ? 'This record is no longer available. Reload the list before editing.'
                : failure instanceof CatalogError && failure.status === 429
                  ? 'Too many requests. Wait before trying again.'
                  : 'Unable to confirm the save. Reload the list and check whether the record was saved before retrying.',
        );
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const payload: Record<string, unknown> = {
      name: fields.name.trim(),
      description: fields.description.trim() || null,
    };
    if (kind === 'products')
      Object.assign(payload, {
        sku: fields.identifier.trim().toUpperCase(),
        categoryId: fields.categoryId || null,
        unitOfMeasure: fields.unitOfMeasure,
        quantityScale: Number(fields.quantityScale),
      });
    if (kind === 'warehouses')
      payload.code = fields.identifier.trim().toUpperCase();
    void write(payload, editor.id, true);
  }

  return (
    <section className="members-card" aria-labelledby="catalog-title">
      <div className="catalog-heading">
        <div>
          <h2 id="catalog-title">{titles[kind]}</h2>
          <p className="muted">
            Organization catalog ·{' '}
            {canEdit
              ? 'Manage records and their active status.'
              : 'Read-only access.'}
          </p>
        </div>
        {canEdit && (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => open()}
          >
            New {label}
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="form-error">
          {error}{' '}
          {!editor && (
            <button
              className="secondary-button"
              onClick={() => {
                setError('');
                setReload((value) => value + 1);
              }}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="save-notice">
          {notice}
        </p>
      )}
      {editor && canEdit && (
        <form
          className="catalog-form"
          onSubmit={save}
          aria-label={`${editor.id ? 'Edit' : 'Create'} ${label}`}
        >
          <h3>
            {editor.id ? 'Edit' : 'New'} {label}
          </h3>
          <div className="catalog-fields">
            <div>
              <label htmlFor="catalog-name">Name</label>
              <input
                id="catalog-name"
                value={fields.name}
                onChange={(event) => field('name', event.target.value)}
                required
                maxLength={200}
                disabled={busy}
              />
            </div>
            {kind !== 'categories' && (
              <div>
                <label htmlFor="catalog-identifier">
                  {kind === 'products' ? 'SKU' : 'Code'}
                </label>
                <input
                  id="catalog-identifier"
                  value={fields.identifier}
                  onChange={(event) =>
                    field('identifier', event.target.value.toUpperCase())
                  }
                  required
                  maxLength={kind === 'products' ? 64 : 32}
                  pattern="[A-Za-z0-9._\-]+"
                  disabled={busy}
                />
                <p className="field-help">
                  Letters, numbers, dots, underscores and hyphens.
                </p>
              </div>
            )}
            <div>
              <label htmlFor="catalog-description">Description</label>
              <input
                id="catalog-description"
                value={fields.description}
                onChange={(event) => field('description', event.target.value)}
                maxLength={2000}
                disabled={busy}
              />
            </div>
            {kind === 'products' && (
              <>
                <div>
                  <label htmlFor="catalog-category">Category</label>
                  <select
                    id="catalog-category"
                    value={fields.categoryId}
                    onChange={(event) =>
                      field('categoryId', event.target.value)
                    }
                    disabled={busy}
                  >
                    <option value="">No category</option>
                    {categories
                      .filter(
                        (item) => item.active || item.id === originalCategoryId,
                      )
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                          {item.active ? '' : ' (inactive)'}
                        </option>
                      ))}
                  </select>
                  {categoryNext !== null && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void more(true)}
                    >
                      Load more category choices
                    </button>
                  )}
                </div>
                <div>
                  <label htmlFor="catalog-unit">Unit of measure</label>
                  <select
                    id="catalog-unit"
                    value={fields.unitOfMeasure}
                    onChange={(event) =>
                      setFields((previous) => ({
                        ...previous,
                        unitOfMeasure: event.target.value,
                        quantityScale:
                          event.target.value === 'UNIT' ? '0' : '3',
                      }))
                    }
                    disabled={busy}
                  >
                    {['UNIT', 'KG', 'G', 'L', 'ML', 'M', 'CM'].map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="catalog-scale">Quantity precision</label>
                  <select
                    id="catalog-scale"
                    value={fields.quantityScale}
                    onChange={(event) =>
                      field('quantityScale', event.target.value)
                    }
                    disabled={busy}
                  >
                    {[0, 1, 2, 3, 4, 5, 6].map((scale) => (
                      <option key={scale} value={scale}>
                        {scale} decimal places
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </div>
          <div className="catalog-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              {busy
                ? 'Saving…'
                : editor.id
                  ? 'Save changes'
                  : `Create ${label}`}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setEditor(null);
                setError('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {items === null ? (
        !error && <p role="status">Loading {kind}…</p>
      ) : items.length === 0 ? (
        <p className="empty-state">
          No {kind} yet.{' '}
          {canEdit
            ? `Create your first ${kind === 'categories' ? 'category' : kind === 'products' ? 'product' : 'warehouse'} to start organizing this workspace.`
            : 'Your team has not added records here yet.'}
        </p>
      ) : (
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Scrollable table"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                {kind !== 'categories' && (
                  <th scope="col">{kind === 'products' ? 'SKU' : 'Code'}</th>
                )}
                {kind === 'products' && <th scope="col">Unit</th>}
                <th scope="col">Status</th>
                {canEdit && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  {kind !== 'categories' && <td>{item.sku ?? item.code}</td>}
                  {kind === 'products' && (
                    <td>
                      {item.unitOfMeasure} · {item.quantityScale} dp
                    </td>
                  )}
                  <td>
                    <StatusBadge status={item.active ? 'Active' : 'Inactive'} />
                  </td>
                  {canEdit && (
                    <td>
                      <div className="row-actions">
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => open(item)}
                        >
                          Edit
                        </button>
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() =>
                            void write({ active: !item.active }, item.id, false)
                          }
                        >
                          {item.active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextOffset !== null && (
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void more()}
        >
          Load more {kind}
        </button>
      )}
    </section>
  );
}
