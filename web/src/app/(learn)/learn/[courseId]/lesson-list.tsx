'use client';

import { useState } from 'react';
import { CheckCircle2, ListVideo, Play } from 'lucide-react';

export interface ListLesson {
  id: string;
  title: string;
  duration_seconds: number;
}
export interface ListSection {
  id: string;
  title: string;
  lessons: ListLesson[];
}

/** The section the learner is in: the active lesson's, else the first with an unfinished lesson, else the first. */
function focusSectionId(sections: ListSection[], activeId: string | null, completedIds: Set<string>) {
  const withActive = activeId ? sections.find((s) => s.lessons.some((l) => l.id === activeId)) : undefined;
  const unfinished = sections.find((s) => s.lessons.some((l) => !completedIds.has(l.id)));
  return (withActive ?? unfinished ?? sections[0])?.id;
}

/**
 * The lesson list. Desktop (lg and up) always shows every section. Below lg it
 * collapses to the current section, behind an "All lessons (n)" disclosure.
 */
export function LessonList({
  sections,
  activeId,
  completedIds,
  watchedPercent,
  onPlay,
}: {
  sections: ListSection[];
  activeId: string | null;
  completedIds: Set<string>;
  watchedPercent: (lessonId: string) => number;
  onPlay: (lessonId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = sections.reduce((n, s) => n + s.lessons.length, 0);
  const focusId = focusSectionId(sections, activeId, completedIds);
  const listId = 'lesson-sections';

  return (
    <>
      <p className="flex items-center justify-between gap-2 px-1 text-sm font-bold uppercase tracking-wider text-gray-500">
        <span className="flex items-center gap-2">
          <ListVideo className="h-4 w-4 text-brand-500" aria-hidden /> Lessons
        </span>
        <span className="text-xs font-semibold normal-case tracking-normal text-gray-500">
          {completedIds.size}/{total} done
        </span>
      </p>
      {sections.length > 1 && (
        <button
          type="button"
          className="btn-secondary w-full !py-2 !text-xs lg:hidden"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show current section only' : `All lessons (${total})`}
        </button>
      )}
      <div id={listId} className="space-y-3">
        {sections.map((section) => {
          const doneInSection = section.lessons.filter((l) => completedIds.has(l.id)).length;
          const collapsed = !expanded && section.id !== focusId;
          return (
            <div key={section.id} className={`card !p-4 ${collapsed ? 'hidden lg:block' : ''}`}>
              <h3 className="flex items-center justify-between gap-2 text-sm font-bold text-foreground">
                <span className="min-w-0 truncate">{section.title}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    doneInSection === section.lessons.length && section.lessons.length > 0
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                      : 'bg-brand-500/10 text-brand-600'
                  }`}
                >
                  {doneInSection}/{section.lessons.length}
                </span>
              </h3>
              <ul className="mt-2 space-y-1">
                {section.lessons.map((lesson) => {
                  const isActive = lesson.id === activeId;
                  const done = completedIds.has(lesson.id);
                  const watched = watchedPercent(lesson.id);
                  return (
                    <li key={lesson.id}>
                      <button
                        onClick={() => onPlay(lesson.id)}
                        aria-current={isActive ? 'true' : undefined}
                        className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition-colors ${
                          isActive ? 'bg-brand-500/10 font-semibold text-brand-600' : 'text-gray-600 hover:bg-brand-500/5 hover:text-foreground'
                        }`}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          {done ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                          ) : (
                            <Play className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-500' : 'text-gray-500'}`} aria-hidden />
                          )}
                          <span className="min-w-0">
                            <span className="block truncate">{lesson.title}</span>
                            {!done && watched > 0 && (
                              <span className="mt-1 block h-1 w-24 overflow-hidden rounded-full bg-gray-200">
                                <span className="block h-full bg-brand-500" style={{ width: `${watched}%` }} />
                              </span>
                            )}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-gray-500">{Math.max(1, Math.round(lesson.duration_seconds / 60))}m</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </>
  );
}
