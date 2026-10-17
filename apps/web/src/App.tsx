import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Catalog } from './Catalog';
import { Inventory } from './Inventory';
import { Purchasing } from './Purchasing';
import { Operations } from './Operations';
import { Imports, Reports } from './DataExchange';

type Session = {
  user: { id: string; email: string; displayName: string };
  organization: { id: string; name: string };
  membership: { id: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' };
  csrfToken: string;
};
type Member = { id: string; role: string; user: Session['user'] };

class RequestError extends Error {
  constructor(public status: number) {
    super(
      status === 429
        ? 'Too many attempts. Please try again later.'
        : 'The request could not be completed. Please try again.',
    );
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(30_000),
    ...options,
  });
  if (!response.ok) throw new RequestError(response.status);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function App() {
  const publicDemo = import.meta.env.VITE_PUBLIC_DEMO === 'true';
  const [tab, setTab] = useState<
    | 'dashboard'
    | 'alerts'
    | 'audit'
    | 'members'
    | 'categories'
    | 'products'
    | 'warehouses'
    | 'inventory'
    | 'purchasing'
    | 'imports'
    | 'reports'
  >('members');
  const onExpired = useCallback(() => {
    setSession(null);
    setMembers(null);
    setError('Your session has expired. Please sign in again.');
  }, []);
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [memberError, setMemberError] = useState(false);
  const [memberAttempt, setMemberAttempt] = useState(0);
  const [memberOffset, setMemberOffset] = useState(0);
  const [memberNext, setMemberNext] = useState<number | null>(null);
  const [memberLoading, setMemberLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    request<Session>('/api/auth/session')
      .then((current) => {
        if (!cancelled) {
          setSession(current);
          if (
            current.organization.name === 'Distribuidora Nova · Fictional demo'
          )
            setTab('dashboard');
          setRestoreError(false);
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setRestoreError(
            !(failure instanceof RequestError && failure.status === 401),
          );
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [restoreAttempt]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setMemberLoading(true);
    setMemberError(false);
    const organizationPath = `/api/organizations/${encodeURIComponent(session.organization.id)}`;
    Promise.all([
      request<{ organization: Session['organization'] }>(organizationPath),
      request<{ memberships: Member[]; nextOffset?: number | null }>(
        `${organizationPath}/memberships${memberOffset ? `?offset=${memberOffset}` : ''}`,
      ),
    ])
      .then(([, data]) => {
        if (!cancelled) {
          setMembers((previous) =>
            memberOffset
              ? [...(previous ?? []), ...data.memberships]
              : data.memberships,
          );
          setMemberNext(data.nextOffset ?? null);
          setMemberError(false);
        }
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        if (failure instanceof RequestError && failure.status === 401) {
          setSession(null);
          setMembers(null);
          setError('Your session has expired. Please sign in again.');
        } else setMemberError(true);
      })
      .finally(() => {
        if (!cancelled) setMemberLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, memberAttempt, memberOffset]);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    const body = {
      email: String(form.get('email')),
      password: String(form.get('password')),
    };
    try {
      const result = await request<Session>(
        `/api/auth/${register ? 'register' : 'login'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            register
              ? {
                  ...body,
                  displayName: String(form.get('displayName')),
                  organizationName: String(form.get('organizationName')),
                }
              : body,
          ),
        },
      );
      setMembers(null);
      setMemberOffset(0);
      setMemberNext(null);
      setMemberError(false);
      setSession(result);
      setTab(
        result.organization.name === 'Distribuidora Nova · Fictional demo'
          ? 'dashboard'
          : 'members',
      );
      setRegister(false);
    } catch (failure) {
      setError(
        failure instanceof RequestError && failure.status === 401
          ? 'Email or password is incorrect.'
          : failure instanceof RequestError && failure.status === 429
            ? failure.message
            : register
              ? 'Unable to create your workspace. Check your details or sign in if you already have an account.'
              : 'Unable to sign in. Check your details and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      await request<void>('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': session.csrfToken },
      });
      setSession(null);
      setMembers(null);
    } catch (failure) {
      if (failure instanceof RequestError && failure.status === 401) {
        setSession(null);
        setMembers(null);
      } else setError('Unable to sign out. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="site-header">
        <a href="#main" className="brand" aria-label="StockFlow home">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          StockFlow<span className="brand-dot">.</span>
        </a>
        <span className="phase-badge">
          <span aria-hidden="true" />
          Your workspace, connected
        </span>
      </header>
      <main id="main" className="auth-main" tabIndex={-1}>
        {restoring ? (
          <p role="status">Restoring your session…</p>
        ) : restoreError ? (
          <section className="auth-card">
            <h1>Connection unavailable</h1>
            <p>We could not check your session. Please try again.</p>
            <button
              className="primary-button"
              onClick={() => {
                setRestoring(true);
                setRestoreAttempt((value) => value + 1);
              }}
            >
              Retry connection
            </button>
          </section>
        ) : session ? (
          <section aria-labelledby="workspace-title">
            <div className="workspace-heading">
              <div>
                <p className="eyebrow">YOUR ORGANIZATION</p>
                <h1 id="workspace-title">{session.organization.name}</h1>
                <p>
                  Signed in as {session.user.displayName} · {session.user.email}
                </p>
                <span className="role-label">{session.membership.role}</span>
              </div>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void logout()}
              >
                {busy ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
            {session.organization.name ===
              'Distribuidora Nova · Fictional demo' && (
              <aside
                className="demo-banner"
                aria-label="Fictional demo workspace"
              >
                <strong>A working day at Distribuidora Nova</strong>
                <p>
                  StockFlow is an inventory and purchasing demo. All people,
                  suppliers and business records in this workspace are
                  fictional.
                </p>
                <p>
                  Start with the dashboard, review critical stock, then follow a
                  purchase order through receiving.
                </p>
                <button
                  className="secondary-button"
                  onClick={() => setTab('dashboard')}
                >
                  Explore the dashboard
                </button>
              </aside>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <nav className="workspace-tabs" aria-label="Workspace sections">
              {(
                [
                  'dashboard',
                  'alerts',
                  ...(session.membership.role !== 'MEMBER'
                    ? ['audit' as const, 'imports' as const]
                    : []),
                  'members',
                  'categories',
                  'products',
                  'warehouses',
                  'inventory',
                  'purchasing',
                  'reports',
                ] as const
              ).map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={tab === item}
                  onClick={() => setTab(item)}
                >
                  {item.charAt(0).toUpperCase() + item.slice(1)}
                </button>
              ))}
            </nav>
            {tab === 'dashboard' || tab === 'alerts' || tab === 'audit' ? (
              <Operations
                key={`${session.organization.id}-${tab}`}
                view={tab}
                organizationId={session.organization.id}
                csrfToken={session.csrfToken}
                canEdit={session.membership.role !== 'MEMBER'}
                onExpired={onExpired}
                navigate={setTab}
              />
            ) : tab === 'imports' ? (
              <Imports
                key={session.organization.id}
                organizationId={session.organization.id}
                csrfToken={session.csrfToken}
                canEdit={session.membership.role !== 'MEMBER'}
                onExpired={onExpired}
              />
            ) : tab === 'reports' ? (
              <Reports
                key={session.organization.id}
                organizationId={session.organization.id}
                canEdit={session.membership.role !== 'MEMBER'}
                onExpired={onExpired}
              />
            ) : tab === 'purchasing' ? (
              <Purchasing
                key={session.organization.id}
                organizationId={session.organization.id}
                csrfToken={session.csrfToken}
                canEdit={session.membership.role !== 'MEMBER'}
                onExpired={onExpired}
              />
            ) : tab === 'inventory' ? (
              <Inventory
                organizationId={session.organization.id}
                csrfToken={session.csrfToken}
                canEdit={session.membership.role !== 'MEMBER'}
                onExpired={onExpired}
              />
            ) : tab !== 'members' ? (
              <Catalog
                key={`${session.organization.id}-${tab}`}
                kind={tab}
                organizationId={session.organization.id}
                csrfToken={session.csrfToken}
                canEdit={session.membership.role !== 'MEMBER'}
                onExpired={onExpired}
              />
            ) : (
              <section className="members-card" aria-labelledby="members-title">
                <h2 id="members-title">Workspace members</h2>
                <p className="muted">People who belong to this organization.</p>
                {memberError ? (
                  <div role="alert">
                    <p>We could not load the members.</p>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setMemberError(false);
                        setMembers(null);
                        setMemberOffset(0);
                        setMemberAttempt((value) => value + 1);
                      }}
                    >
                      Retry members
                    </button>
                  </div>
                ) : members === null ? (
                  <p role="status">Loading members…</p>
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
                          <th scope="col">Email</th>
                          <th scope="col">Role</th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.map((member) => (
                          <tr key={member.id}>
                            <td>{member.user.displayName}</td>
                            <td>{member.user.email}</td>
                            <td>
                              <span className="role-label">{member.role}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {memberNext !== null && !memberError && (
                  <button
                    className="secondary-button"
                    disabled={memberLoading}
                    onClick={() => setMemberOffset(memberNext)}
                  >
                    {memberLoading ? 'Loading members…' : 'Load more members'}
                  </button>
                )}
              </section>
            )}
            <p className="scope-note">
              Inventory and purchasing, connected to your organization.
            </p>
            <p className="scope-note">
              If a write loses its connection, retry the same values while this
              view stays open. After reloading or leaving the view, check stock,
              movement history, order receipts or audit history before repeating
              the operation: the original request may have succeeded.
            </p>
          </section>
        ) : (
          <div className="auth-layout">
            <section className="auth-intro">
              <p className="eyebrow">INVENTORY & PURCHASING</p>
              <h1>
                Inventory,
                <br />
                <span>with confidence.</span>
              </h1>
              <p>
                Inventory and purchasing for growing teams. Know what is in
                stock, move goods between warehouses and keep purchases on
                track.
              </p>
              <p className="scope-note">
                Track inventory and manage purchase orders with your team.
              </p>
            </section>
            <section className="auth-card" aria-labelledby="auth-title">
              <h2 id="auth-title">
                {register ? 'Create your workspace' : 'Welcome back'}
              </h2>
              <p className="muted">
                {register
                  ? 'One account. One organization. A clear starting point.'
                  : 'Sign in to your StockFlow organization.'}
              </p>
              <form onSubmit={(event) => void authenticate(event)}>
                {register && (
                  <>
                    <label htmlFor="displayName">Full name</label>
                    <input
                      id="displayName"
                      name="displayName"
                      autoComplete="name"
                      required
                      maxLength={100}
                      disabled={busy}
                    />
                    <label htmlFor="organizationName">Organization name</label>
                    <input
                      id="organizationName"
                      name="organizationName"
                      autoComplete="organization"
                      required
                      maxLength={160}
                      disabled={busy}
                    />
                  </>
                )}
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  disabled={busy}
                />
                <label htmlFor="password">Password</label>
                <input
                  key={register ? 'new' : 'current'}
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  required
                  minLength={register ? 12 : undefined}
                  maxLength={128}
                  aria-describedby={register ? 'password-help' : undefined}
                  disabled={busy}
                />
                {register && (
                  <p id="password-help" className="field-help">
                    Use 12–128 characters.
                  </p>
                )}
                {error && (
                  <p role="alert" className="form-error">
                    {error}
                  </p>
                )}
                <button
                  className="primary-button"
                  type="submit"
                  disabled={busy}
                >
                  {busy
                    ? 'Please wait…'
                    : register
                      ? 'Create workspace'
                      : 'Sign in'}
                </button>
              </form>
              {publicDemo ? (
                <aside aria-label="Public fictional demo accounts">
                  <p>
                    Fictional portfolio demo. All visitors share sample data.
                  </p>
                  <p>
                    OWNER: <strong>owner@nova.example.test</strong>
                    <br />
                    MEMBER: <strong>member@nova.example.test</strong>
                    <br />
                    Demo password: <code>Nova-demo-only-42!</code>
                  </p>
                  <p>
                    Use fictional information only. Registration is disabled.
                  </p>
                </aside>
              ) : (
                <p className="auth-switch">
                  {register ? 'Already have an account?' : 'New to StockFlow?'}{' '}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setRegister(!register);
                      setError('');
                    }}
                  >
                    {register ? 'Sign in' : 'Create a workspace'}
                  </button>
                </p>
              )}
            </section>
          </div>
        )}
      </main>
      <footer>
        <span>StockFlow · Inventory, with confidence</span>
        <span>Inventory · Purchasing · Traceability</span>
      </footer>
    </div>
  );
}
