import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Field } from './Field';

afterEach(cleanup);

describe('<Field />', () => {
  it('links the label to the control and the hint to aria-describedby', () => {
    render(<Field label="Email" hint="We never share it">{(ids) => <input {...ids} />}</Field>);
    const input = screen.getByLabelText('Email');
    const hint = screen.getByText('We never share it');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('shows the error as an alert, marks the control invalid and describes it by hint and error', () => {
    render(
      <Field label="Email" hint="Hint text" error="Enter a valid email">
        {(ids) => <input {...ids} />}
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Enter a valid email');
    expect(alert.className).toContain('text-red-600');
    expect(alert.className).toContain('dark:text-red-400');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = input.getAttribute('aria-describedby')!.split(' ');
    expect(ids).toContain(alert.id);
    expect(ids).toContain(screen.getByText('Hint text').id);
  });

  it('has no aria-describedby without hint or error and gives each field its own id', () => {
    render(
      <>
        <Field label="A">{(ids) => <input {...ids} />}</Field>
        <Field label="B">{(ids) => <input {...ids} />}</Field>
      </>,
    );
    expect(screen.getByLabelText('A').hasAttribute('aria-describedby')).toBe(false);
    expect(screen.getByLabelText('A').id).not.toBe(screen.getByLabelText('B').id);
  });
});
