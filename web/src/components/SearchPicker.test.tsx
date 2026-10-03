import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchPicker, type PickerOption } from './SearchPicker';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const people: PickerOption[] = [
  { id: '1', label: 'Abebe Bekele' },
  { id: '2', label: 'Abel Tesfaye' },
];

function Harness({ fetcher }: { fetcher: (q: string) => Promise<PickerOption[]> }) {
  const [selected, setSelected] = useState<PickerOption | null>(null);
  return <SearchPicker label="Learner" selected={selected} onSelect={setSelected} fetcher={fetcher} />;
}

function setup(fetcher: (q: string) => Promise<PickerOption[]>) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness fetcher={fetcher} />
    </QueryClientProvider>,
  );
  return screen.getByRole('combobox', { name: 'Learner' });
}

/** Types, waits out the debounce, then waits for the options to render (react-query notifies on its own timer). */
const search = async (input: HTMLElement, value: string) => {
  await type(input, value);
  await screen.findAllByRole('option', undefined, { timeout: 1000 });
};

const type = async (input: HTMLElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
};

describe('<SearchPicker />', () => {
  it('waits for typing to settle before searching, and only once', async () => {
    const fetcher = vi.fn().mockResolvedValue(people);
    const input = setup(fetcher);
    fireEvent.change(input, { target: { value: 'ab' } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    fireEvent.change(input, { target: { value: 'abe' } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('abe');
  });

  it('does not search for a single character', async () => {
    const fetcher = vi.fn().mockResolvedValue(people);
    await type(setup(fetcher), 'a');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('arrow keys move through the options and Enter selects, showing a chip', async () => {
    const input = setup(vi.fn().mockResolvedValue(people));
    await search(input, 'ab');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const second = screen.getAllByRole('option')[1];
    expect(input.getAttribute('aria-activedescendant')).toBe(second.id);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Abebe Bekele')).toBeTruthy();
  });

  it('Escape closes the list without selecting', async () => {
    const input = setup(vi.fn().mockResolvedValue(people));
    await search(input, 'ab');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('says "No matches" when the search finds nothing', async () => {
    const input = setup(vi.fn().mockResolvedValue([]));
    await search(input, 'zz');
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('clicking an option selects it, and the named clear button brings the input back', async () => {
    const input = setup(vi.fn().mockResolvedValue(people));
    await search(input, 'ab');
    fireEvent.mouseDown(screen.getByText('Abel Tesfaye'));
    expect(screen.getByText('Abel Tesfaye')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear learner' }));
    expect((screen.getByRole('combobox', { name: 'Learner' }) as HTMLInputElement).value).toBe('');
  });

  it('two pickers with the same label keep their own results', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The app's cache keeps results fresh for a while: a shared cache key would hand one picker the other's list.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
    const paid = vi.fn().mockResolvedValue([{ id: 'p', label: 'Paid course' }]);
    const every = vi.fn().mockResolvedValue([{ id: 'f', label: 'Free course' }]);
    render(
      <QueryClientProvider client={client}>
        <div data-testid="first">
          <SearchPicker label="Course" selected={null} onSelect={() => undefined} fetcher={every} />
        </div>
        <div data-testid="second">
          <SearchPicker label="Course" selected={null} onSelect={() => undefined} fetcher={paid} />
        </div>
      </QueryClientProvider>,
    );
    const [first, second] = screen.getAllByRole('combobox', { name: 'Course' });
    await search(first, 'co');
    expect(screen.getByRole('option', { name: 'Free course' })).toBeTruthy();
    fireEvent.blur(first);
    await search(second, 'co');
    expect(paid).toHaveBeenCalledWith('co');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Paid course']);
  });
});
