import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LessonList } from './lesson-list';

const sections = [
  { id: 's1', title: 'Basics', lessons: [{ id: 'l1', title: 'Soil', duration_seconds: 300 }] },
  { id: 's2', title: 'Advanced', lessons: [{ id: 'l2', title: 'Irrigation', duration_seconds: 300 }] },
];

function renderList(completed: string[] = []) {
  return render(<LessonList sections={sections} activeId={null} completedIds={new Set(completed)} watchedPercent={() => 0} onPlay={() => undefined} />);
}

/** The element that folds the section (the one that carries the visibility class). */
const folder = (title: string) => screen.getByText(title).closest('.overflow-hidden')!;

describe('lesson list', () => {
  it('the All lessons disclosure unfolds the sections below the current one', () => {
    renderList();
    expect(folder('Basics').className).not.toContain('invisible');
    expect(folder('Advanced').className).toContain('invisible');
    fireEvent.click(screen.getByRole('button', { name: 'All lessons (2)' }));
    expect(folder('Advanced').className).not.toContain('invisible');
    expect(screen.getByRole('button', { name: 'Show current section only' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('a completed lesson shows a check, which fades and scales in', () => {
    const { container } = renderList(['l1']);
    expect(container.querySelector('.check-pop')).not.toBeNull();
    expect(screen.getByText('Completed')).toBeTruthy();
  });
});
