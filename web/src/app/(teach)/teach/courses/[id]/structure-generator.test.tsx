import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ExtractResult } from '@/lib/extract-text';

const apiMock = vi.fn();
const extractMock = vi.fn();
/** For each condensing step: whether "Condensing…" was already on screen when it started. */
const { condensing } = vi.hoisted(() => ({ condensing: [] as boolean[] }));

vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => apiMock(...args) }));
// The real extractor points pdf.js at /pdf.worker.min.mjs in a browser-like environment.
vi.mock('@/lib/extract-text', () => ({
  extractDocument: (...args: unknown[]) => extractMock(...args),
  textToBlocks: (text: string) => text.split('\n').filter(Boolean).map((line) => ({ kind: 'para', text: line })),
}));
vi.mock('@/lib/outline-source', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/outline-source')>();
  return {
    ...real,
    buildDigest: (...args: Parameters<typeof real.buildDigest>) => {
      condensing.push(!!document.body.textContent?.includes('Condensing…'));
      return real.buildDigest(...args);
    },
  };
});

import { StructureGenerator } from './structure-generator';

const book: ExtractResult = {
  blocks: [
    { kind: 'heading', text: 'Chapter 1 Soil basics', level: 1 },
    { kind: 'para', text: 'Soil is a living system. It holds water and nutrients for crops.' },
    { kind: 'heading', text: 'Chapter 2 Irrigation', level: 1 },
    { kind: 'para', text: 'Drip irrigation saves water. It suits small farms in dry seasons.' },
    { kind: 'heading', text: 'Chapter 3 Harvest', level: 1 },
    { kind: 'para', text: 'Harvest at the right time. Store grain dry and off the ground.' },
  ],
  outline: [],
  pages: 12,
  chars: 1234,
  fullText: 'Chapter 1 Soil basics\nSoil is a living system…',
};

function renderGenerator(live = false) {
  const onApplied = vi.fn();
  render(<StructureGenerator courseId="c1" title="Farming 101" live={live} disabled={false} autoOpen onApplied={onApplied} />);
  return { onApplied };
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function sourceBox() {
  return screen.getByPlaceholderText(/paste your document/) as HTMLTextAreaElement;
}

async function upload(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
  // Reading, then condensing after a macrotask break.
  await flush();
  await flush();
}

beforeEach(() => {
  apiMock.mockReset();
  extractMock.mockReset();
  condensing.length = 0;
});

/** Paste `text` over the box's current selection; returns false when the browser's own paste was cancelled. */
function paste(text: string) {
  return fireEvent.paste(sourceBox(), { clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') } });
}

/** Plain prose of exactly `chars` characters. */
function prose(chars: number) {
  let out = '';
  for (let i = 0; out.length < chars; i++) out += `Topic ${i} is explained in one plain sentence here.\n`;
  return out.slice(0, chars);
}
afterEach(cleanup);

describe('<StructureGenerator /> file reading', () => {
  it('shows page progress, puts only the digest in the box and reports its size', async () => {
    let finish!: (r: ExtractResult) => void;
    extractMock.mockImplementation((_file: File, opts: { onProgress: (i: number, n: number) => void }) => {
      opts.onProgress(3, 12);
      return new Promise((resolve) => (finish = resolve));
    });
    renderGenerator();
    await upload(new File(['%PDF'], 'farming.pdf', { type: 'application/pdf' }));
    expect(screen.getByText('Reading page 3/12…')).toBeTruthy();

    await act(async () => finish(book));
    const digest = sourceBox().value;
    expect(digest).toMatch(/^DOCUMENT OUTLINE/);
    expect(digest).toContain('Chapter 2 Irrigation');
    expect(digest).not.toBe(book.fullText);
    expect(screen.getByText(`farming.pdf: full document: 12 pages / 1,234 chars → sending a ${digest.length.toLocaleString('en-US')}-char digest`)).toBeTruthy();
    // The digest of a large book is a long synchronous step: "Condensing…" was painted before it began.
    expect(condensing).toEqual([true]);
  });

  it('can be stopped while the text is being condensed', async () => {
    let finish!: (r: ExtractResult) => void;
    extractMock.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    renderGenerator();
    await upload(new File(['%PDF'], 'farming.pdf', { type: 'application/pdf' }));
    // Hold the macrotask break the condensing step waits for (React's act uses setImmediate, not setTimeout).
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await act(async () => finish(book));
      expect(screen.getByText('Condensing…')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await act(async () => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(condensing).toEqual([]);
    expect(sourceBox().value).toBe('');
    expect(screen.getByText('Stopped reading the file.')).toBeTruthy();
  });

  it('shows the warning and leaves the box empty for an unreadable file', async () => {
    extractMock.mockResolvedValue({ blocks: [], outline: [], pages: 5, chars: 0, fullText: '', warning: 'This PDF has no text layer — it looks scanned.' });
    renderGenerator();
    await upload(new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' }));
    expect(screen.getByText('This PDF has no text layer — it looks scanned.')).toBeTruthy();
    expect(sourceBox().value).toBe('');
  });

  it('fills the box and still shows a warning that comes with text', async () => {
    extractMock.mockResolvedValue({ ...book, warning: 'Only the first 1000 of 1200 pages were read.' });
    renderGenerator();
    await upload(new File(['%PDF'], 'huge.pdf', { type: 'application/pdf' }));
    expect(screen.getByText('Only the first 1000 of 1200 pages were read.')).toBeTruthy();
    expect(sourceBox().value).toMatch(/^DOCUMENT OUTLINE/);
  });
});

describe('<StructureGenerator /> generate and apply', () => {
  const outline = {
    ai_live: false,
    sections: [{ title: 'Soil basics', is_free_preview: true, lessons: [{ title: 'What soil is', summary: 'Soil is alive.' }, { title: 'Testing soil' }] }],
  };

  async function generateDraft(live = false, reply: object = outline, text = 'Chapter 1 Soil basics') {
    const utils = renderGenerator(live);
    fireEvent.change(sourceBox(), { target: { value: text } });
    apiMock.mockResolvedValueOnce(reply);
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await flush();
    return utils;
  }

  it('sends the text and shows the API’s note over an outline built from the document’s headings', async () => {
    const note = "AI is offline — this is a starter outline built from your document's headings; edit it.";
    await generateDraft(false, { ...outline, origin: 'headings', note });
    expect(apiMock).toHaveBeenCalledWith('/courses/generate-structure', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ source_text: 'Chapter 1 Soil basics' }) }));
    // Once, as the banner over the draft — not again as a note under Generate.
    expect(screen.getAllByText(note)).toHaveLength(1);
    expect((screen.getByLabelText('Lesson 1 summary') as HTMLInputElement).value).toBe('Soil is alive.');
  });

  it('does not claim the document’s headings for a generic placeholder outline', async () => {
    await generateDraft(false, { ...outline, origin: 'placeholder' }, 'Some unstructured notes about soil.');
    expect(screen.getByText(/no headings were found in your text, so this is a generic starter outline/)).toBeTruthy();
    expect(screen.queryByText(/built from your document's headings/)).toBeNull();
  });

  it('never claims the headings when the API does not say how the outline was built', async () => {
    await generateDraft();
    expect(screen.queryByText(/built from your document's headings/)).toBeNull();
    expect(screen.getByText(/generic starter outline/)).toBeTruthy();
  });

  it('shows no banner over a model outline, and still shows a note that comes with it', async () => {
    await generateDraft(false, { ...outline, ai_live: true, origin: 'model', note: 'Trimmed to 12 sections.' });
    expect(screen.queryByText(/starter outline/)).toBeNull();
    expect(screen.getByText('Trimmed to 12 sections.')).toBeTruthy();
  });

  it('condenses typed text over the model budget before sending, and says so', async () => {
    const typed = prose(26_000);
    await generateDraft(false, { ...outline, ai_live: true, origin: 'model' }, typed);
    const body = apiMock.mock.calls[0][1].body as { source_text: string };
    expect(body.source_text.length).toBeLessThanOrEqual(24_000);
    expect(body.source_text).not.toBe(typed);
    expect(sourceBox().value).toBe(body.source_text);
    expect(screen.getByText(/Condensed because the AI reads at most 24,000 characters at once \(fewer for Amharic text\): 26,000 chars/)).toBeTruthy();
    expect(condensing).toEqual([true]);
  });

  it('applies the edited outline in one call, with summaries, then clears the draft', async () => {
    const { onApplied } = await generateDraft(true);
    fireEvent.change(screen.getByLabelText('Lesson 2 summary'), { target: { value: 'Use a simple jar test.' } });
    apiMock.mockReset();
    apiMock.mockResolvedValueOnce({ applied: true, sections_added: 1, lessons_added: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Add all to course' }));
    await flush();

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith('/courses/c1/apply-structure', {
      method: 'POST',
      body: {
        sections: [
          {
            title: 'Soil basics',
            is_free_preview: true,
            lessons: [
              { title: 'What soil is', summary: 'Soil is alive.' },
              { title: 'Testing soil', summary: 'Use a simple jar test.' },
            ],
          },
        ],
      },
    });
    expect(screen.getByText('Added 1 section / 2 lessons — staged: submit your changes for review to publish them.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add all to course' })).toBeNull();
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft when applying fails, so a retry cannot duplicate anything', async () => {
    const { onApplied } = await generateDraft();
    apiMock.mockRejectedValueOnce(new Error('This course is in review. Withdraw it to make changes.'));
    fireEvent.click(screen.getByRole('button', { name: 'Add all to course' }));
    await flush();
    expect(screen.getByText('This course is in review. Withdraw it to make changes.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add all to course' })).toBeTruthy();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('does not send an outline with an empty lesson title', async () => {
    await generateDraft();
    fireEvent.change(screen.getByLabelText('Lesson 1 title'), { target: { value: ' ' } });
    apiMock.mockReset();
    fireEvent.click(screen.getByRole('button', { name: 'Add all to course' }));
    await flush();
    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Lesson 1 in "Soil basics" needs a title/)).toBeTruthy();
  });
});

describe('<StructureGenerator /> pasted text', () => {
  it('lets a paste within the budget through as typed', () => {
    renderGenerator();
    expect(paste('Chapter 1 Soil basics')).toBe(true);
    expect(condensing).toEqual([]);
  });

  it('condenses a paste between 24,000 and 30,000 characters instead of letting the server cut its end', async () => {
    renderGenerator();
    const notes = prose(29_000);
    expect(paste(notes)).toBe(false);
    await flush();
    expect(condensing).toEqual([true]);
    expect(sourceBox().value.length).toBeLessThanOrEqual(24_000);
    expect(screen.getByText(/Condensed because the AI reads at most 24,000 characters .*: 29,000 chars → sending a/)).toBeTruthy();
    expect(screen.queryByText(/Too long to send as it is/)).toBeNull();
    // The pasted notes are whole: they can go to the tutor.
    expect(screen.getByRole('button', { name: /Also add the full text to the course tutor/ })).toBeTruthy();
  });

  it('condenses pasted Amharic that is over the token budget though under 24,000 characters', async () => {
    renderGenerator();
    expect(paste('ሰላም ለዓለም። '.repeat(1_300))).toBe(false);
    await flush();
    expect(condensing).toEqual([true]);
  });

  it('stops offering the uploaded book to the tutor once other text is pasted into its digest', async () => {
    extractMock.mockResolvedValue(book);
    renderGenerator();
    await upload(new File(['%PDF'], 'farming.pdf', { type: 'application/pdf' }));
    expect(screen.getByRole('button', { name: /Also add the full text to the course tutor/ })).toBeTruthy();

    paste('\nAlso cover mobile money.');
    await flush();
    expect(screen.queryByRole('button', { name: /Also add the full text to the course tutor/ })).toBeNull();
    expect(screen.getByText(/no longer matches “farming\.pdf”.*upload the file again/)).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('keeps offering the book when the paste leaves the box unchanged', async () => {
    extractMock.mockResolvedValue(book);
    renderGenerator();
    await upload(new File(['%PDF'], 'farming.pdf', { type: 'application/pdf' }));
    const box = sourceBox();
    box.setSelectionRange(0, box.value.length);
    paste(box.value);
    await flush();
    expect(screen.getByRole('button', { name: /Also add the full text to the course tutor/ })).toBeTruthy();
  });

  it('sends pasted notes that replaced the whole box to the tutor, not the book or the digest', async () => {
    extractMock.mockResolvedValue(book);
    renderGenerator();
    await upload(new File(['%PDF'], 'farming.pdf', { type: 'application/pdf' }));
    const box = sourceBox();
    box.setSelectionRange(0, box.value.length);
    const notes = prose(29_000);
    paste(notes);
    await flush();
    apiMock.mockResolvedValueOnce({ chunks: 30 });
    fireEvent.click(screen.getByRole('button', { name: /Also add the full text to the course tutor/ }));
    await flush();
    expect(apiMock).toHaveBeenCalledWith('/courses/c1/knowledge', { method: 'POST', body: { title: 'Pasted notes', text: notes } });
  });
});
