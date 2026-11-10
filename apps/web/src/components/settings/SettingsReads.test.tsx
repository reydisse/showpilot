vi.mock("./KioskDutyRoster", () => ({ KioskDutyRoster: () => null }));
vi.mock("./KioskTeamEditor", () => ({ KioskTeamEditor: () => null }));
vi.mock("./KioskDisplayControl", () => ({ KioskDisplayControl: () => null }));
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KioskSection } from './KioskSection';
import { CompanionSection } from './CompanionSection';

const mocks = vi.hoisted(() => ({ list:vi.fn(), create:vi.fn(), revoke:vi.fn() }));
vi.mock('@/lib/companion', () => ({ listCompanionTokens:mocks.list, createCompanionToken:mocks.create, revokeCompanionToken:mocks.revoke }));
const kiosk = vi.hoisted(() => ({ teams:vi.fn(), tokens:vi.fn(), blank:vi.fn() }));
vi.mock('@/lib/kiosk-admin', () => ({ getKioskTeams:kiosk.teams }));
vi.mock('@/lib/kiosk', () => ({ listKioskTokens:kiosk.tokens, createKioskToken:vi.fn(), revokeKioskToken:vi.fn() }));
vi.mock('@/lib/kiosk-display', () => ({ getKioskBlankState:kiosk.blank, setKioskBlankState:vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  kiosk.teams.mockResolvedValue([]); kiosk.tokens.mockResolvedValue([]); kiosk.blank.mockResolvedValue({ blanked:false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = async (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('Settings list recovery', () => {
  it('bounds the token read, rejects a late reply and retries only the read', async () => {
    let resolve: (value: unknown[]) => void = () => {};
    mocks.list.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue([]);
    render(<CompanionSection orgId="one" slug="one" />);
    await tick(8000);
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.queryByText(/No tokens yet/)).toBeNull();
    const retry = screen.getByRole('button', {name:'Retry Companion tokens'});
    expect(screen.getByRole('alert', {name:'Retry Companion tokens'}).querySelector('time')).not.toBeNull();
    await act(async () => resolve([{id:'late',label:'Late token',createdAt:new Date(),expiresAt:null}]));
    expect(screen.queryByText('Late token')).toBeNull();
    fireEvent.click(retry); await tick();
    expect(screen.getByText(/No tokens yet/)).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
});

it('keeps a newly issued token through read failure and invalidates the pre-creation reply', async () => {
  let oldReply: (value: unknown[]) => void = () => {};
  mocks.list.mockImplementationOnce(() => new Promise(done => { oldReply = done; }))
    .mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue([{id:'new',label:'New desk',createdAt:new Date(),expiresAt:null}]);
  mocks.create.mockResolvedValue({id:'new',label:'New desk',token:'fixture-token'});
  render(<CompanionSection orgId="one" slug="one" />); await tick();
  fireEvent.change(screen.getByLabelText('Token label'), {target:{value:'New desk'}});
  fireEvent.click(screen.getByRole('button',{name:'Generate'})); await tick();
  expect(mocks.list.mock.calls[0][0].signal.aborted).toBe(true);
  expect(screen.getByLabelText('New token')).toHaveProperty('value','fixture-token');
  await tick(8000);
  expect(screen.queryByText(/No tokens yet/)).toBeNull();
  await act(async () => oldReply([{id:'old',label:'Stale token',createdAt:new Date(),expiresAt:null}]));
  expect(screen.queryByText('Stale token')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Retry Companion tokens'})); await tick();
  expect(screen.getAllByText('New desk')).toHaveLength(2);
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.revoke).not.toHaveBeenCalled();
  expect(screen.getByLabelText('New token')).toHaveProperty('value','fixture-token');
});

it('cancels token reads when the organization changes', async () => {
  let oldReply: (value: unknown[]) => void = () => {};
  mocks.list.mockImplementationOnce(() => new Promise(done => { oldReply = done; })).mockResolvedValue([]);
  const {rerender} = render(<CompanionSection orgId="one" slug="one" />); await tick();
  rerender(<CompanionSection orgId="two" slug="two" />); await tick();
  expect(mocks.list.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => oldReply([{id:'one',label:'Other organization',createdAt:new Date(),expiresAt:null}]));
  expect(screen.queryByText('Other organization')).toBeNull();
  expect(screen.getByText(/No tokens yet/)).toBeTruthy();
});

it('bounds the org-chart read without showing a partial result and leaves token access reachable', async () => {
  kiosk.teams.mockImplementation(() => new Promise(() => {}));
  render(<KioskSection userId="fixture-user" orgId="one" slug="one" members={[]} />);
  await tick(8000);
  expect(screen.queryByText('Loading kiosk organization…')).toBeNull();
  expect(screen.queryByText('Unconfirmed team')).toBeNull(); expect(screen.queryByText(/No teams yet/)).toBeNull();
  expect(screen.getByRole('button',{name:'Retry kiosk organization'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Access Tokens'})); await tick();
  expect(screen.getByText(/No tokens yet/)).toBeTruthy();
});

it('hydrates the Companion page on a non-production origin without changing server markup', async () => {
  mocks.list.mockResolvedValue([]);
  let html: string;
  vi.stubGlobal('window', undefined);
  try { html = renderToString(<CompanionSection orgId="one" slug="one" />); }
  finally { vi.unstubAllGlobals(); }
  expect(html).toContain('Preparing connection URL');
  const container = document.createElement('div'); container.innerHTML = html; document.body.appendChild(container);
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, <CompanionSection orgId="one" slug="one" />, {onRecoverableError:error=>errors.push(error)}); });
    await tick();
    expect(errors).toEqual([]);
    expect(container.textContent).toContain(window.location.origin);
    expect(container.querySelector('button[title="Copy as curl"]')).toHaveProperty('disabled',false);
  } finally { await act(async () => root?.unmount()); container.remove(); }
});
