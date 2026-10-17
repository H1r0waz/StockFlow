const labels: Record<string, string> = {
  OK: 'Healthy stock',
  LOW: 'Low stock',
  OUT_OF_STOCK: 'Out of stock',
  DRAFT: 'Draft',
  SENT: 'Sent to supplier',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Fully received',
  CANCELLED: 'Cancelled',
  Active: 'Active',
  Inactive: 'Inactive',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`status-badge status-${status.toLowerCase()}`}
      title={labels[status] ?? status}
    >
      {status}
    </span>
  );
}

export function readableLabel(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());
}
