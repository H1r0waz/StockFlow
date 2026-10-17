import { readableLabel } from './StatusBadge';
import { useEffect, useRef, useState } from 'react';

type Props = {
  organizationId: string;
  csrfToken: string;
  canEdit: boolean;
  onExpired: () => void;
};
type Preview = {
  id: string;
  type: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  token: string;
  expiresAt: string;
  rows: {
    row: number;
    operation: string;
    data?: Record<string, unknown>;
    errors: string[];
  }[];
};
type Job = {
  id: string;
  status: string;
  totalRows: number;
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
};
class CsvError extends Error {
  constructor(public status: number) {
    super('Request failed');
  }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(30_000),
    ...options,
  });
  if (!response.ok) throw new CsvError(response.status);
  return response.json() as Promise<T>;
}
export function Imports({
  organizationId,
  csrfToken,
  canEdit,
  onExpired,
}: Props) {
  const [type, setType] = useState('products');
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const base = `/api/organizations/${encodeURIComponent(organizationId)}/imports/${type}`;
  function reset() {
    generation.current += 1;
    setPreview(null);
    setJob(null);
    setError('');
    setBusy(false);
  }
  async function load(file?: File) {
    reset();
    setCsv('');
    setFilename('');
    if (!file) return;
    const current = generation.current;
    if (file.size > 256 * 1024) {
      setError('Choose a CSV file no larger than 256 KiB.');
      return;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (current !== generation.current) return;
      setCsv(text);
      setFilename(file.name);
    } catch {
      if (current === generation.current)
        setError('The file must contain valid UTF-8 text.');
    }
  }
  async function submit(confirm: boolean) {
    if (!canEdit || busy || !csv || (confirm && !preview)) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      if (confirm) {
        const result = await request<{ job: Job }>(`${base}/confirm`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ csv, token: preview!.token }),
        });
        if (current === generation.current) {
          setJob(result.job);
          setPreview(null);
        }
      } else {
        const result = await request<{ preview: Preview }>(`${base}/preview`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ csv }),
        });
        if (current === generation.current) {
          setPreview(result.preview);
          setJob(null);
        }
      }
    } catch (failure) {
      if (current !== generation.current) return;
      if (failure instanceof CsvError && failure.status === 401) onExpired();
      else if (failure instanceof CsvError && failure.status === 403)
        setError(
          'You do not have permission to import data. Refresh your session.',
        );
      else if (failure instanceof CsvError && failure.status === 429)
        setError('Too many requests. Wait before trying again.');
      else if (failure instanceof CsvError && failure.status === 404)
        setError(
          'This import is no longer available. Check audit history before starting a new import.',
        );
      else if (failure instanceof CsvError && failure.status === 409) {
        setPreview(null);
        setError(
          'The preview is stale or expired. Preview the file again before confirming.',
        );
      } else
        setError(
          confirm
            ? 'Confirmation could not be completed. Retry confirmation with the same file and preview.'
            : 'Unable to preview this file. Check its CSV headers, size and values.',
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  if (!canEdit)
    return (
      <section className="members-card">
        <h2>CSV imports</h2>
        <p>Only owners and administrators can import data.</p>
      </section>
    );
  return (
    <section className="members-card">
      <h2>CSV imports</h2>
      <p>
        No changes are saved until you confirm a valid preview. Files must use
        UTF-8 and be no larger than 256 KiB.
      </p>
      <label htmlFor="import-type">Import type</label>
      <select
        id="import-type"
        value={type}
        onChange={(e) => {
          reset();
          setType(e.target.value);
        }}
      >
        {['products', 'suppliers'].map((value) => (
          <option key={value} value={value}>
            {readableLabel(value)}
          </option>
        ))}
      </select>
      <p>
        CSV headers are case-sensitive. Products require sku, name,
        unitOfMeasure; optional quantityScale, categoryId, description.
        Suppliers require name; optional email, phone, taxId, notes. Products
        match existing SKU. Suppliers are create-only; duplicate nonempty tax
        IDs are rejected. Names never update existing suppliers. Review every
        proposed operation before confirming.
      </p>
      <details>
        <summary>CSV examples</summary>
        <pre>
          {type === 'products'
            ? 'sku,name,unitOfMeasure,quantityScale\nDEMO-RICE,Demo rice,KG,3'
            : 'name,email,taxId\nDemo supplier,supplier@example.test,DEMO-TAX-01'}
        </pre>
      </details>
      <label htmlFor="csv-file">CSV file</label>
      <input
        id="csv-file"
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => void load(e.target.files?.[0])}
      />
      {filename && <p>Selected file: {filename}</p>}
      <button disabled={busy || !csv} onClick={() => void submit(false)}>
        Preview import
      </button>
      {busy && <p role="status">Processing import…</p>}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <>
          <h3>Import preview</h3>
          <p>
            {preview.totalRows} rows: {preview.validRows} valid,{' '}
            {preview.invalidRows} invalid. Create {preview.createdRows}, update{' '}
            {preview.updatedRows}, skip {preview.skippedRows}.
          </p>
          <p className="field-help">
            Preview expires:{' '}
            <time dateTime={preview.expiresAt}>
              {new Date(preview.expiresAt).toLocaleString()}
            </time>
            . If records change, create a new preview before confirming.
          </p>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Scrollable table"
          >
            <table aria-label="Import preview">
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Operation</th>
                  <th scope="col">Data</th>
                  <th scope="col">Errors</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.row}>
                    <td>{row.row}</td>
                    <td>{readableLabel(row.operation)}</td>
                    <td>
                      {row.data ? (
                        <dl className="preview-data">
                          {Object.entries(row.data).map(([key, value]) => (
                            <div key={key}>
                              <dt>{readableLabel(key)}</dt>
                              <dd>{String(value ?? '—')}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{row.errors.join('; ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            disabled={
              busy ||
              preview.invalidRows > 0 ||
              Date.parse(preview.expiresAt) <= Date.now()
            }
            onClick={() => void submit(true)}
          >
            Confirm import
          </button>
        </>
      )}
      {job && (
        <div role="status">
          <h3>Import confirmed</h3>
          <p>
            Job {job.id}: {job.status}. Created {job.createdRows}, updated{' '}
            {job.updatedRows}, skipped {job.skippedRows}, failed{' '}
            {job.failedRows}.
          </p>
        </div>
      )}
    </section>
  );
}

type Report = {
  columns: string[];
  rows: Record<string, string | null>[];
  hasMore: boolean;
  nextOffset: number | null;
};
const filters: Record<string, string[]> = {
  products: ['active', 'categoryId'],
  suppliers: ['active'],
  inventory: ['productId', 'warehouseId'],
  movements: ['productId', 'warehouseId', 'type', 'from', 'to'],
  'purchase-orders': ['status', 'supplierId', 'from', 'to'],
  receipts: ['warehouseId', 'purchaseOrderId', 'from', 'to'],
  audit: ['actorId', 'entityId', 'entityType', 'action', 'from', 'to'],
  alerts: ['productId', 'warehouseId', 'status'],
};
export function Reports({
  organizationId,
  canEdit,
  onExpired,
}: Omit<Props, 'csrfToken'>) {
  const [type, setType] = useState('products');
  const [values, setValues] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const query = new URLSearchParams({
    ...Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== ''),
    ),
    limit: '50',
    offset: String(offset),
  }).toString();
  const base = `/api/organizations/${encodeURIComponent(organizationId)}`;
  useEffect(() => {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setReport(null);
    request<Report>(`${base}/reports/${type}?${query}`)
      .then((result) => {
        if (current === generation.current) setReport(result);
      })
      .catch((failure: unknown) => {
        if (current !== generation.current) return;
        if (failure instanceof CsvError && failure.status === 401) onExpired();
        else
          setError(
            failure instanceof CsvError && failure.status === 403
              ? 'You do not have permission to view this report.'
              : failure instanceof CsvError && failure.status === 429
                ? 'Too many requests. Wait before trying again.'
                : 'Unable to load this report. Check the filters and try again.',
          );
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      generation.current += 1;
    };
  }, [base, type, query, attempt, onExpired]);
  async function download() {
    const current = generation.current;
    setDownloading(true);
    setError('');
    try {
      const response = await fetch(`${base}/exports/${type}?${query}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new CsvError(response.status);
      const blob = await response.blob();
      if (current !== generation.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `stockflow-${type}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (failure) {
      if (current === generation.current) {
        if (failure instanceof CsvError && failure.status === 401) onExpired();
        else setError('Unable to export this report. Please retry.');
      }
    } finally {
      setDownloading(false);
    }
  }
  return (
    <section className="members-card">
      <h2>Operational reports</h2>
      <p>
        Each page contains at most 50 rows. CSV export downloads only the
        current filtered page.
      </p>
      <label htmlFor="report-type">Report type</label>
      <select
        id="report-type"
        value={type}
        onChange={(e) => {
          setType(e.target.value);
          setValues({});
          setOffset(0);
        }}
      >
        {Object.keys(filters)
          .filter((value) => value !== 'audit' || canEdit)
          .map((value) => (
            <option key={value}>{value}</option>
          ))}
      </select>
      <div className="report-filters">
        {(filters[type] ?? []).map((field) => (
          <div key={field}>
            <label htmlFor={`report-${field}`}>{readableLabel(field)}</label>
            {field === 'active' ? (
              <select
                id={`report-${field}`}
                aria-label={`Report ${field}`}
                value={values[field] ?? ''}
                onChange={(e) => {
                  setValues((previous) => ({
                    ...previous,
                    [field]: e.target.value,
                  }));
                  setOffset(0);
                }}
              >
                <option value="">All</option>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            ) : (
              <input
                id={`report-${field}`}
                value={values[field] ?? ''}
                placeholder={
                  field === 'from' || field === 'to'
                    ? 'ISO date, e.g. 2026-10-17T00:00:00Z'
                    : undefined
                }
                onChange={(e) => {
                  setValues((previous) => ({
                    ...previous,
                    [field]: e.target.value,
                  }));
                  setOffset(0);
                }}
              />
            )}
          </div>
        ))}
      </div>
      <button disabled={busy} onClick={() => setAttempt((value) => value + 1)}>
        Refresh report
      </button>
      <button
        disabled={busy || downloading || !report}
        onClick={() => void download()}
      >
        Export CSV page
      </button>
      {busy && <p role="status">Loading report…</p>}
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Scrollable table"
          >
            <table aria-label="Operational report">
              <thead>
                <tr>
                  {report.columns.map((column) => (
                    <th key={column} scope="col">
                      {readableLabel(column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row, index) => (
                  <tr key={`${offset}-${index}`}>
                    {report.columns.map((column) => (
                      <td key={column}>{row[column] ?? '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!report.rows.length && (
            <p className="empty-state">
              No matching rows. Adjust the filters or choose another report to
              explore your organization’s records.
            </p>
          )}
          <p>
            Rows {report.rows.length ? offset + 1 : 0}–
            {offset + report.rows.length}
          </p>
          <button
            disabled={busy || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous report page
          </button>
          <button
            disabled={busy || report.nextOffset === null}
            onClick={() => setOffset(report.nextOffset!)}
          >
            Next report page
          </button>
        </>
      )}
    </section>
  );
}
