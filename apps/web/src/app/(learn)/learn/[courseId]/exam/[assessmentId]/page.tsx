'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { ProctorEngine, ProctorStatus, Violation, VIOLATION_LABELS } from '@/lib/proctor';

interface ExamQuestion {
  index: number;
  kind: 'mcq' | 'written';
  prompt: string;
  options?: string[];
  points: number;
}

interface StartedAttempt {
  attempt_id: string;
  questions: ExamQuestion[];
  pass_score: number;
  proctored: boolean;
  time_limit_minutes: number | null;
  warning_limit: number;
}

interface SubmitResult {
  score: number;
  passed: boolean;
  flagged: boolean;
  terminated: boolean;
  termination_reason?: string;
  breakdown?: { index: number; kind: string; earned: number; points: number; correct?: boolean; ai_score?: number; ai_feedback?: string }[];
}

interface ProctorReport {
  events: { type: string; description: string; at: string; screenshot_url: string | null }[];
  terminated: boolean;
  termination_reason: string | null;
}

type Phase = 'preflight' | 'exam' | 'done';

function ExamRoom({ courseId, assessmentId }: { courseId: string; assessmentId: string }) {
  const router = useRouter();
  const { data: assessments } = useQuery({
    queryKey: ['assessments', courseId],
    queryFn: () => api<any[]>(`/assessments?course_id=${courseId}`),
  });
  const meta = assessments?.find((a) => a.id === assessmentId);

  const [phase, setPhase] = useState<Phase>('preflight');
  const [attempt, setAttempt] = useState<StartedAttempt | null>(null);
  const [responses, setResponses] = useState<Record<number, { selected_index?: number; text?: string }>>({});
  const [warnings, setWarnings] = useState<Record<string, number>>({});
  const [banner, setBanner] = useState<{ text: string; key: number } | null>(null);
  const [proctorStatus, setProctorStatus] = useState<ProctorStatus>({ camera: 'off', faceModel: 'loading', faces: null });
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [report, setReport] = useState<ProctorReport | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const engineRef = useRef<ProctorEngine | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const attemptRef = useRef<StartedAttempt | null>(null);
  const responsesRef = useRef(responses);
  const endedRef = useRef(false);
  responsesRef.current = responses;

  const proctored = !!meta?.proctored;

  // The <video> element remounts between phases — re-attach the stream each time.
  const setVideoEl = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
    if (el) engineRef.current?.attachVideo(el);
  }, []);

  const endExam = useCallback(
    async (opts: { terminated?: boolean; reason?: string } = {}) => {
      if (endedRef.current) return;
      endedRef.current = true;
      setSubmitting(true);
      engineRef.current?.stop();
      const current = attemptRef.current;
      if (!current) return;
      const body = {
        responses: current.questions.map((q) => ({
          index: q.index,
          selected_index: responsesRef.current[q.index]?.selected_index ?? null,
          text: responsesRef.current[q.index]?.text ?? null,
        })),
        ...(opts.terminated ? { terminated: true, termination_reason: opts.reason } : {}),
      };
      try {
        const res = await api<SubmitResult>(`/attempts/${current.attempt_id}/submit`, { method: 'PUT', body });
        setResult(res);
        try {
          setReport(await api<ProctorReport>(`/attempts/${current.attempt_id}/proctor-report`));
        } catch {
          /* report is best-effort */
        }
      } catch (err) {
        setError((err as Error).message);
        endedRef.current = false; // let the learner retry the submit
      }
      setSubmitting(false);
      setPhase('done');
    },
    [],
  );

  const handleViolationRef = useRef<(v: Violation) => Promise<void>>(async () => {});

  // One engine per proctored exam session; survives the preflight→exam transition.
  useEffect(() => {
    if (!proctored) return;
    const engine = new ProctorEngine({
      onStatus: setProctorStatus,
      onViolation: (v) => void handleViolationRef.current(v),
    });
    engineRef.current = engine;
    if (videoElRef.current) engine.attachVideo(videoElRef.current);
    void engine.startCamera();
    void engine.loadFaceModel();
    return () => {
      engine.stop();
      engineRef.current = null;
    };
  }, [proctored]);

  const handleViolation = useCallback(
    async (v: Violation) => {
      const current = attemptRef.current;
      if (!current || endedRef.current) return;
      try {
        const res = await api<{ count: number; remaining: number; terminate: boolean }>(
          `/attempts/${current.attempt_id}/proctor-events`,
          { method: 'POST', body: v },
        );
        setWarnings((w) => ({ ...w, [v.type]: res.count }));
        if (res.terminate) {
          setBanner({ text: `Exam ended: ${v.description}`, key: Date.now() });
          await endExam({ terminated: true, reason: `3rd violation: ${VIOLATION_LABELS[v.type] ?? v.type}` });
        } else {
          setBanner({
            text: `⚠️ Warning ${res.count} of ${current.warning_limit} — ${v.description}. ${res.remaining} more and the exam ends.`,
            key: Date.now(),
          });
        }
      } catch {
        /* keep the exam usable if a report call drops */
      }
    },
    [endExam],
  );
  handleViolationRef.current = handleViolation;

  const start = async () => {
    setError('');
    try {
      const res = await api<StartedAttempt>(`/assessments/${assessmentId}/attempts`, { method: 'POST' });
      attemptRef.current = res;
      endedRef.current = false;
      setAttempt(res);
      setPhase('exam');
      if (res.time_limit_minutes) setSecondsLeft(res.time_limit_minutes * 60);
      // Monitors arm AFTER the attempt exists so violations attach to it.
      engineRef.current?.arm();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Countdown → auto-submit on time-up.
  useEffect(() => {
    if (phase !== 'exam' || secondsLeft === null) return;
    if (secondsLeft <= 0) {
      void endExam();
      return;
    }
    const t = setTimeout(() => setSecondsLeft((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [phase, secondsLeft, endExam]);

  // Warn on refresh/close mid-exam.
  useEffect(() => {
    if (phase !== 'exam') return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [phase]);

  const answered = attempt ? attempt.questions.filter((q) => (q.kind === 'mcq' ? responses[q.index]?.selected_index !== undefined : (responses[q.index]?.text ?? '').trim().length > 0)).length : 0;

  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ---------- PREFLIGHT ----------
  if (phase === 'preflight') {
    const cameraReady = !proctored || proctorStatus.camera === 'on';
    const modelState = proctorStatus.faceModel;
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-xl font-bold">{meta?.type === 'quiz' ? 'Exam' : 'Assessment'}: ready to begin?</h1>
        <div className="card space-y-3">
          <p className="text-sm text-gray-700">
            {meta?.question_count ?? '…'} questions{meta?.written_count ? ` (${meta.written_count} written, AI-graded)` : ''} · pass ≥ {meta?.pass_score ?? '…'}%
            {meta?.time_limit_minutes ? ` · ⏱ ${meta.time_limit_minutes} min limit` : ''}
          </p>
          {proctored ? (
            <>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-semibold">📹 This exam is proctored. During the exam:</p>
                <ul className="ml-5 mt-1 list-disc space-y-0.5">
                  <li>Your camera stays on — keep your face visible, alone, facing the screen</li>
                  <li>Do not switch tabs or windows</li>
                  <li>Copy and paste are disabled</li>
                  <li>Each rule gives <b>3 warnings</b>; a 3rd strike of the same rule ends the exam automatically</li>
                  <li>Every violation is recorded with a camera snapshot your educator can review</li>
                </ul>
              </div>
              <div className="flex items-center gap-4">
                <video ref={setVideoEl} muted playsInline className="h-32 w-44 rounded-lg bg-gray-900 object-cover" />
                <div className="space-y-1 text-sm">
                  <p>{proctorStatus.camera === 'on' ? '✅ Camera ready' : proctorStatus.camera === 'denied' ? '❌ Camera blocked — allow camera access to start' : '⏳ Requesting camera…'}</p>
                  <p>
                    {modelState === 'ready' && (proctorStatus.faces === null ? '✅ Face detection ready' : proctorStatus.faces === 1 ? '✅ One face detected' : proctorStatus.faces === 0 ? '👀 Position your face in view' : '⚠️ Multiple faces in view')}
                    {modelState === 'loading' && '⏳ Loading face detection…'}
                    {modelState === 'unavailable' && '⚠️ Face detection unavailable — tab & clipboard monitoring still apply'}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700">This quiz is not proctored. Answer every question, then submit.</p>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
            I understand the exam rules{proctored ? ' and consent to camera monitoring during the exam' : ''}.
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button className="btn" disabled={!agreed || !cameraReady || (proctored && modelState === 'loading')} onClick={start}>
              Start exam
            </button>
            <button className="btn-secondary" onClick={() => router.push(`/learn/${courseId}`)}>Back to course</button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- RESULT / TERMINATED ----------
  if (phase === 'done') {
    const terminated = result?.terminated;
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        {result ? (
          <div className={`card border-2 ${terminated ? 'border-red-300 bg-red-50' : result.passed ? 'border-green-300 bg-green-50' : 'border-amber-300'}`}>
            {terminated ? (
              <>
                <h1 className="text-xl font-bold text-red-800">🚫 Exam ended by proctoring</h1>
                <p className="mt-1 text-sm text-red-700">{result.termination_reason ?? 'Repeated violations of the exam rules.'} The attempt is flagged for your educator with the full violation report below.</p>
              </>
            ) : (
              <>
                <h1 className="text-xl font-bold">{result.passed ? '🎉 Passed' : 'Not passed yet'}</h1>
                <p className="mt-1 text-3xl font-bold">{result.score}%</p>
                {result.flagged && <p className="mt-1 text-sm text-amber-700">⚠️ This attempt has proctoring flags — see the report below.</p>}
              </>
            )}
          </div>
        ) : (
          <div className="card">
            <p className="text-sm text-red-600">{error || 'Submitting…'}</p>
            {error && <button className="btn mt-2" disabled={submitting} onClick={() => void endExam()}>Try submitting again</button>}
          </div>
        )}

        {result?.breakdown && attempt && (
          <div className="card">
            <h2 className="font-semibold">Question results</h2>
            <ul className="mt-2 space-y-3">
              {result.breakdown.map((b) => {
                const q = attempt.questions.find((x) => x.index === b.index);
                return (
                  <li key={b.index} className="rounded-lg border p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-medium">{b.index + 1}. {q?.prompt}</p>
                      <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${b.earned >= b.points ? 'bg-green-100 text-green-800' : b.earned > 0 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-700'}`}>
                        {b.earned}/{b.points} pt{b.points !== 1 ? 's' : ''}
                      </span>
                    </div>
                    {b.kind === 'written' ? (
                      <div className="mt-1 text-gray-700">
                        <p className="text-xs text-gray-500">AI grade: {b.ai_score}%</p>
                        {b.ai_feedback && <p className="mt-0.5">{b.ai_feedback}</p>}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-gray-500">{b.correct ? 'Correct ✓' : 'Incorrect ✗'}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {report && report.events.length > 0 && (
          <div className="card">
            <h2 className="font-semibold">📹 Proctoring report ({report.events.length} flag{report.events.length !== 1 ? 's' : ''})</h2>
            <ul className="mt-2 space-y-3">
              {report.events.map((e, i) => (
                <li key={i} className="flex gap-3 rounded-lg border p-3">
                  {e.screenshot_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={e.screenshot_url} alt={`Flag ${i + 1} snapshot`} className="h-20 w-28 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded bg-gray-100 text-xs text-gray-400">no image</div>
                  )}
                  <div className="text-sm">
                    <p className="font-medium">{VIOLATION_LABELS[e.type] ?? e.type}</p>
                    <p className="text-gray-600">{e.description}</p>
                    <p className="mt-0.5 text-xs text-gray-400">{new Date(e.at).toLocaleString()}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => router.push(`/learn/${courseId}`)}>Back to course</button>
          {result && !result.passed && (
            <button className="btn" onClick={() => window.location.reload()}>Retake exam</button>
          )}
        </div>
      </div>
    );
  }

  // ---------- EXAM ----------
  return (
    <div className="mx-auto max-w-3xl select-none">
      {/* sticky exam header */}
      <div className="sticky top-0 z-20 -mx-2 mb-4 flex items-center justify-between gap-3 rounded-b-xl border-b bg-white/95 px-4 py-2 shadow-sm backdrop-blur">
        <div className="text-sm font-semibold">{answered}/{attempt?.questions.length} answered</div>
        <div className="flex items-center gap-2 text-xs">
          {Object.entries(warnings).map(([t, n]) => (
            <span key={t} className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">{VIOLATION_LABELS[t] ?? t}: {n}/{attempt?.warning_limit}</span>
          ))}
          {secondsLeft !== null && (
            <span className={`rounded px-2 py-0.5 font-mono font-semibold ${secondsLeft < 60 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}`}>⏱ {fmtTime(secondsLeft)}</span>
          )}
        </div>
      </div>

      {banner && (
        <div key={banner.key} className="mb-4 animate-pulse rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm font-medium text-amber-900">
          {banner.text}
        </div>
      )}

      <div className="space-y-4 pb-24">
        {attempt?.questions.map((q) => (
          <div key={q.index} className="card">
            <p className="text-sm font-medium">
              {q.index + 1}. {q.prompt} <span className="text-xs font-normal text-gray-400">({q.points} pt{q.points !== 1 ? 's' : ''}{q.kind === 'written' ? ' · written, AI-graded' : ''})</span>
            </p>
            {q.kind === 'mcq' ? (
              <div className="mt-2 space-y-1">
                {q.options?.map((opt, j) => (
                  <label key={j} className="flex cursor-pointer items-center gap-2 rounded p-1 text-sm hover:bg-gray-50">
                    <input
                      type="radio"
                      name={`q${q.index}`}
                      checked={responses[q.index]?.selected_index === j}
                      onChange={() => setResponses((r) => ({ ...r, [q.index]: { selected_index: j } }))}
                    />
                    {opt}
                  </label>
                ))}
              </div>
            ) : (
              <textarea
                className="input mt-2 select-text"
                rows={5}
                placeholder="Write your answer in your own words… (paste is disabled)"
                value={responses[q.index]?.text ?? ''}
                onChange={(e) => setResponses((r) => ({ ...r, [q.index]: { text: e.target.value } }))}
              />
            )}
          </div>
        ))}

        <button className="btn w-full" disabled={submitting} onClick={() => void endExam()}>
          {submitting ? 'Submitting…' : `Submit exam (${answered}/${attempt?.questions.length} answered)`}
        </button>
      </div>

      {/* live camera thumb */}
      {proctored && (
        <div className="fixed bottom-4 right-4 z-30 overflow-hidden rounded-xl border-2 border-white shadow-lg">
          <video ref={setVideoEl} muted playsInline className="h-24 w-32 bg-gray-900 object-cover" />
          <div className={`absolute bottom-1 left-1 rounded px-1.5 text-[10px] font-semibold text-white ${proctorStatus.faces === 1 ? 'bg-green-600' : 'bg-red-600'}`}>
            {proctorStatus.faceModel !== 'ready' ? 'REC' : proctorStatus.faces === 1 ? '● OK' : proctorStatus.faces === 0 ? '● NO FACE' : `● ${proctorStatus.faces} FACES`}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ExamPage() {
  const params = useParams<{ courseId: string; assessmentId: string }>();
  return (
    <RequireRole roles={['learner']}>
      <ExamRoom courseId={params.courseId} assessmentId={params.assessmentId} />
    </RequireRole>
  );
}
