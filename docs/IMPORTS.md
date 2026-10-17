# Safe catalog imports

Phase 9 imports products and suppliers only. Categories, warehouses and inventory movements are deliberately outside the import contract. Importing catalog data never writes a balance, ledger movement, transfer, order or receipt.

## API and authorization

All routes require a current OWNER or ADMIN membership in the active organization. Both POST routes require CSRF protection. MEMBER receives 403; another organization remains inaccessible.

- `POST /api/organizations/:organizationId/imports/:type/preview` accepts `{csv}` and returns `{preview}` with HTTP 200.
- `POST /api/organizations/:organizationId/imports/:type/confirm` accepts the identical `{csv, token}` and returns `{job}` with HTTP 201, including an identical confirmed replay.
- `GET /api/organizations/:organizationId/imports/:id` returns `{job}` without the raw CSV, token, contact fields or internal payload hash.

`type` is `products` or `suppliers`. Unexpected request fields and unsupported types are rejected. The CSV is a UTF-8 string transported in JSON. The server accepts at most 256 KiB of UTF-8 CSV bytes, 2,000 nonblank data records and 8 columns; the surrounding import JSON transport is separately bounded. No external parser or service is required.

## CSV dialect and normalization

The parser accepts an optional initial UTF-8 BOM, comma delimiters, LF or CRLF record endings, quoted fields, doubled quotes and embedded line breaks inside quoted fields. Blank records are ignored. Unterminated quotes, quotes embedded in unquoted text, characters after a closing quote, duplicate or unknown headers and inconsistent row widths are rejected or reported as row errors. NUL, replacement characters and unpaired UTF-16 surrogates are rejected. Row numbers identify the source record's starting physical line.

Products require `sku,name,unitOfMeasure`. Optional columns are `quantityScale,categoryId,description`. Headers are case-sensitive. SKU uses the existing catalog normalization to uppercase and remains the unique identity within the organization. Names and descriptions reuse catalog validation. Units are UNIT, KG, G, L, ML, M or CM. Optional precision uses the catalog defaults (UNIT 0, other units 3) for new products; existing defaults are preserved when omitted. An explicitly supplied precision must be one digit from 0 to 6.

An existing SKU is updated only if normalized fields differ, otherwise skipped. The CSV cannot change `active`. Omitted optional columns preserve existing values; a supplied empty category or description clears that value. Category references must belong to the current organization; an inactive category may be retained but cannot be newly assigned. Unit or precision changes are rejected if the product already has movements, purchase order lines or minimum thresholds. Duplicate normalized SKUs within the same file invalidate the batch.

Suppliers require `name`; optional columns are `email,phone,taxId,notes`. They are create-only: names are not unique identities and never imply an update. Optional values are trimmed and empty values become null. Email is normalized to lowercase. Existing and within-file duplicate nonempty tax IDs are rejected. Empty tax IDs may occur on multiple suppliers, matching the existing database contract.

## Preview and confirmation

Preview reports `id,type,totalRows,validRows,invalidRows,createdRows,updatedRows,skippedRows,rows,token,expiresAt`. Each row includes `row,operation,data,errors`; operations are CREATE, UPDATE, SKIP or ERROR. Invalid rows have no normalized data. A preview does not persist an import job or modify business records.

A signed, opaque token binds the organization, actor, type, exact CSV SHA-256, normalized plan and relevant current database state, proposed job UUID and expiration. Preview lifetime is 30 minutes. A process-local random signing secret is never returned. Process restart invalidates outstanding preview tokens; obtain a new preview. Confirmed job status remains durable and queryable by ID.

Confirmation parses bounded input again, acquires the same organization lock as catalog and membership writes, revalidates the live session and role, and checks for a previously confirmed matching job. An existing confirmed job replays without applying catalog changes or audit again, including after the preview expiration within the same process. A new confirmation must not be expired. It rebuilds the entire plan, including current category state, matching product identity/version/history and supplier tax identities. Any changed fingerprint returns 409 STALE_PREVIEW and requires a new preview; expired unconfirmed previews return 409 EXPIRED_PREVIEW. Invalid rows reject the complete batch.

The organization lock serializes concurrent confirmations and relevant normal business mutations. Product and supplier creates use bounded `createMany`; product updates run only for changed rows. The interactive transaction has a 30 second timeout. Catalog effects, job and IMPORT_CONFIRM audit commit together or all roll back. No partially successful job is recorded. Successful jobs contain counts with status CONFIRMED, invalidRows and failedRows zero. The immutable job retains only identity, actor, type, payload hash, counts and timestamps; raw input and sensitive row fields are not stored there. Database triggers reject job UPDATE and DELETE.

Audit emits one IMPORT_CONFIRM event with allowlisted type/count metadata, plus ordinary catalog events for actual creates and updates. Every event uses the import job UUID as its correlation key. Skipped rows produce no catalog update audit. Existing safe audit field allowlists remain in force; contact values, supplier notes and the uploaded CSV do not enter audit metadata.

## Operational limits

This is a synchronous, bounded import suitable for the current MVP. A timeout or any constraint failure rolls back the entire import; the client may retry the same confirmation. OFFSET reports and catalog pages can shift under concurrent mutations; imports do not provide a large-file/background queue. Supplier names without tax IDs can be intentionally duplicated across different confirmed previews. Reusing the same confirmed preview is idempotent; submitting a different preview is a new command.

See [catalog](CATALOG.md), [audit](AUDIT.md), and [Phase 9 verification](PHASE9_VERIFICATION.md) for the surrounding contracts and executed evidence.
