import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmProvider, useConfirm, type ConfirmOptions, type ConfirmResult } from './ConfirmProvider';

afterEach(cleanup);

let results: Promise<ConfirmResult>[] = [];
function Trigger({ options }: { options: ConfirmOptions }) {
  const ask = useConfirm();
  return (
    <button onClick={() => results.push(ask(options))}>open</button>
  );
}

function setup(options: ConfirmOptions) {
  results = [];
  render(
    <ConfirmProvider>
      <Trigger options={options} />
    </ConfirmProvider>,
  );
  const trigger = screen.getByRole('button', { name: 'open' });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: document.querySelector('dialog')! };
}

const base: ConfirmOptions = { title: 'Ban Abebe?', body: 'They lose access.', confirmLabel: 'Ban user', tone: 'danger' };

describe('useConfirm', () => {
  it('opens a labelled modal dialog and focuses Cancel for a danger action', () => {
    const { dialog } = setup(base);
    expect(dialog.open).toBe(true);
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Ban Abebe?');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('They lose access.');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('focuses Confirm for a default action', () => {
    setup({ title: 'Publish?', confirmLabel: 'Publish' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Publish' }));
  });

  it('Cancel resolves false, closes the dialog and returns focus', async () => {
    const { dialog, trigger } = setup(base);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await results[0]).toBe(false);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape (the cancel event) resolves false and returns focus', async () => {
    const { dialog, trigger } = setup(base);
    act(() => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(await results[0]).toBe(false);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('Confirm resolves with an empty reason when none was asked for', async () => {
    setup(base);
    fireEvent.click(screen.getByRole('button', { name: 'Ban user' }));
    expect(await results[0]).toEqual({ reason: '' });
  });

  it('a required reason gets focus, keeps Confirm disabled until long enough, and comes back trimmed', async () => {
    setup({ ...base, reason: { label: 'Reason', required: true, minLength: 5 } });
    const field = screen.getByLabelText('Reason');
    const confirm = screen.getByRole('button', { name: 'Ban user' }) as HTMLButtonElement;
    expect(document.activeElement).toBe(field);
    expect(confirm.disabled).toBe(true);
    expect(document.getElementById(field.getAttribute('aria-describedby') ?? '')?.textContent).toBe('At least 5 characters.');
    fireEvent.change(field, { target: { value: ' abc ' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '  spam account ' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(await results[0]).toEqual({ reason: 'spam account' });
  });

  it('an optional reason does not block Confirm', async () => {
    setup({ ...base, reason: { label: 'Note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban user' }));
    expect(await results[0]).toEqual({ reason: '' });
  });

  it('a second call resolves the first as false and shows only the new dialog', async () => {
    const { dialog } = setup(base);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(await results[0]).toBe(false);
    expect(document.querySelectorAll('dialog')).toHaveLength(1);
    expect(dialog.open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Ban user' }));
    expect(await results[1]).toEqual({ reason: '' });
  });
});
