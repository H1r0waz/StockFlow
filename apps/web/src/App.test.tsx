import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const session = {
  user: {
    id: 'user-1',
    email: 'owner@example.test',
    displayName: 'Alex Owner',
  },
  organization: { id: 'org-1', name: 'Example Warehouse' },
  membership: { id: 'member-1', role: 'OWNER' },
  csrfToken: 'csrf-test-token',
};
const memberships = [{ id: 'member-1', role: 'OWNER', user: session.user }];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  vi.stubEnv('VITE_PUBLIC_DEMO', 'false');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('authentication UI with mocked HTTP responses (not database verification)', () => {
  it('offers only the fictional sample login when the public demo build is enabled', async () => {
    vi.stubEnv('VITE_PUBLIC_DEMO', 'true');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Welcome back' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create a workspace' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('complementary', {
        name: 'Public fictional demo accounts',
      }),
    ).toHaveTextContent('owner@nova.example.test');
    expect(
      screen.getByText(
        'Use fictional information only. Registration is disabled.',
      ),
    ).toBeInTheDocument();
  });
  it('leaves session restoration recoverable when the request times out', async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_path: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Request timed out', 'TimeoutError')),
            );
          }),
      ),
    );
    render(<App />);
    expect(timeout).toHaveBeenCalledWith(30_000);
    controller.abort();
    expect(
      await screen.findByRole('heading', { name: 'Connection unavailable' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry connection' }),
    ).toBeEnabled();
  });
  it('keeps organization content protected and offers registration when anonymous', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Welcome back' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Workspace members' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create a workspace' }));
    expect(screen.getByLabelText('Organization name')).toBeRequired();
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'minlength',
      '12',
    );
  });

  it('restores the session, renders members, and sends CSRF on logout', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/auth/session') return Promise.resolve(json(session));
      if (path === '/api/organizations/org-1')
        return Promise.resolve(json(session.organization));
      if (path === '/api/organizations/org-1/memberships')
        return Promise.resolve(json({ memberships }));
      if (path === '/api/auth/logout')
        return Promise.resolve(new Response(null, { status: 204 }));
      throw new Error('Unexpected route');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Example Warehouse' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('cell', { name: 'owner@example.test' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Skip to main content' }),
    ).toHaveAttribute('href', '#main');
    expect(
      screen.getByRole('region', { name: 'Scrollable table' }),
    ).toHaveAttribute('tabindex', '0');
    expect(
      screen.getByText(/After reloading or leaving the view/),
    ).toHaveTextContent('the original request may have succeeded');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('heading', { name: 'Welcome back' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', {
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
      method: 'POST',
      headers: { 'X-CSRF-Token': 'csrf-test-token' },
    });
  });

  it('submits login details and shows a safe error for invalid credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({}, 401));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: 'Welcome back' });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrong-password' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'Sign in' }).closest('form')!,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Email or password is incorrect.',
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'owner@example.test',
          password: 'wrong-password',
        }),
      }),
    );
  });

  it('creates an organization and displays the authenticated workspace', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/auth/session') return Promise.resolve(json({}, 401));
      if (path === '/api/auth/register')
        return Promise.resolve(json(session, 201));
      if (path === '/api/auth/logout')
        return Promise.resolve(new Response(null, { status: 204 }));
      if (path.endsWith('/memberships'))
        return Promise.resolve(json({ memberships }));
      return Promise.resolve(json(session.organization));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create a workspace' }),
    );
    for (const [label, value] of [
      ['Full name', 'Alex Owner'],
      ['Organization name', 'Example Warehouse'],
      ['Email', 'owner@example.test'],
      ['Password', 'strong-password-123'],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.submit(
      screen.getByRole('button', { name: 'Create workspace' }).closest('form')!,
    );
    expect(
      await screen.findByRole('heading', { name: 'Example Warehouse' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('cell', { name: 'Alex Owner' }),
      ).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/register',
      expect.objectContaining({
        body: JSON.stringify({
          email: 'owner@example.test',
          password: 'strong-password-123',
          displayName: 'Alex Owner',
          organizationName: 'Example Warehouse',
        }),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('heading', { name: 'Welcome back' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
  });

  it('does not silently treat a connection failure as an anonymous session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Connection unavailable' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Sign in' }),
    ).not.toBeInTheDocument();
  });
});

it('loads membership pages and ignores an outstanding page after logout', async () => {
  let finishPage: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn().mockImplementation((path: string) => {
    if (path === '/api/auth/session') return Promise.resolve(json(session));
    if (path.endsWith('/memberships'))
      return Promise.resolve(json({ memberships, nextOffset: 50 }));
    if (path.endsWith('/memberships?offset=50'))
      return Promise.resolve(
        json({
          memberships: [
            {
              id: 'member-2',
              role: 'MEMBER',
              user: {
                id: 'u2',
                displayName: 'Second Member',
                email: 'second@example.test',
              },
            },
          ],
          nextOffset: 100,
        }),
      );
    if (path.endsWith('/memberships?offset=100'))
      return new Promise<Response>((resolve) => {
        finishPage = resolve;
      });
    if (path === '/api/auth/logout')
      return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json(session.organization));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Load more members' }),
  );
  expect(
    await screen.findByRole('cell', { name: 'Second Member' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'Alex Owner' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more members' }));
  await waitFor(() => expect(finishPage).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByRole('heading', { name: 'Welcome back' });
  finishPage!(
    json({
      memberships: [
        {
          id: 'stale',
          role: 'MEMBER',
          user: {
            id: 'stale',
            displayName: 'Stale Member',
            email: 'stale@example.test',
          },
        },
      ],
      nextOffset: null,
    }),
  );
  await waitFor(() =>
    expect(screen.queryByText('Stale Member')).not.toBeInTheDocument(),
  );
});
it('opens the fictional demo on its operational dashboard without bypassing session authentication', async () => {
  const mock = vi.fn().mockImplementation((path: string) =>
    Promise.resolve(
      json(
        path === '/api/auth/session'
          ? {
              ...session,
              organization: {
                id: 'org-1',
                name: 'Distribuidora Nova · Fictional demo',
              },
            }
          : path.includes('/dashboard')
            ? {
                dashboard: {
                  activeProducts: 36,
                  activeWarehouses: 3,
                  lowStockProducts: 3,
                  outOfStockProducts: 2,
                  purchaseOrders: {
                    DRAFT: 2,
                    SENT: 2,
                    PARTIALLY_RECEIVED: 2,
                    recentReceived: 2,
                  },
                  recentMovements: [],
                  recentReceipts: [],
                },
              }
            : path.includes('/memberships')
              ? { memberships }
              : path.includes('/alerts')
                ? { alerts: [] }
                : { organization: session.organization },
      ),
    ),
  );
  vi.stubGlobal('fetch', mock);
  render(<App />);
  expect(
    await screen.findByRole('heading', { name: 'Operational dashboard' }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('Fictional demo workspace')).toHaveTextContent(
    'All people, suppliers and business records in this workspace are fictional',
  );
  expect(mock.mock.calls.some(([path]) => path === '/api/auth/session')).toBe(
    true,
  );
  expect(mock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
