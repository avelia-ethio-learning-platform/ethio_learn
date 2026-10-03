'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, FileUp, Mic, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { formatBytes, putFile, type UploadState } from '@/lib/upload';
import { UploadProgress } from '@/components/UploadProgress';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { assessmentTypeLabel } from '@/lib/labels';

interface AssessmentSummary {
  id: string;
  type: 'quiz' | 'ai_viva' | 'project';
  is_required: boolean;
  pass_score: number;
  question_count?: number;
}

export function AssessmentsPanel({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const { data: assessments } = useQuery({
    queryKey: ['assessments', courseId],
    queryFn: () => api<AssessmentSummary[]>(`/assessments?course_id=${courseId}`),
  });
  const { data: attempts } = useQuery({ queryKey: ['attempts', courseId], queryFn: () => api<any[]>(`/attempts/mine?course_id=${courseId}`) });
  const [active, setActive] = useState<any | null>(null);
  const [status, setOk, setError, clearStatus, setInfo] = useFormStatus();

  if (!assessments?.length) return null;

  const passed = (assessmentId: string) => attempts?.some((a) => a.assessment_id === assessmentId && a.passed);

  const start = async (assessment: AssessmentSummary) => {
    clearStatus();
    try {
      const res = await api<any>(`/assessments/${assessment.id}/attempts`, { method: 'POST' });
      setActive({ ...res, assessment });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const finish = async (body: Record<string, unknown>) => {
    try {
      const res = await api<any>(`/attempts/${active.attempt_id}/submit`, { method: 'PUT', body });
      const feedback = res.feedback ? ` · ${res.feedback}` : '';
      // A score that did not pass is not a success: it goes out politely, in the warning colours.
      if (res.pending_review) setOk('Submitted — your educator will review it.');
      else if (res.passed) setOk(`Score: ${res.score} — PASSED 🎉${feedback}`);
      else setInfo(`Score: ${res.score} — not passed yet${feedback}`);
      setActive(null);
      await queryClient.invalidateQueries({ queryKey: ['attempts', courseId] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="card mt-6">
      <h3 className="flex items-center gap-2 font-bold text-foreground">
        <span className="glass-secondary flex h-9 w-9 items-center justify-center rounded-xl">
          <ClipboardCheck className="h-4 w-4 text-brand-600" />
        </span>
        Assessments
      </h3>
      <ul className="mt-3 space-y-2 text-sm">
        {assessments.map((a) => (
          <li key={a.id} className="glass-secondary flex items-center justify-between gap-3 rounded-xl px-4 py-2.5">
            <span className="text-foreground">
              {assessmentTypeLabel(a.type)}{' '}
              {a.is_required && <span className="text-xs font-normal text-gray-500">(required for certificate)</span>}
            </span>
            {passed(a.id) ? (
              <span className="badge-success">
                <CheckCircle2 className="h-3 w-3" /> Passed
              </span>
            ) : (
              <button className="btn-secondary !px-3 !py-1 !text-xs" aria-label={`Start ${assessmentTypeLabel(a.type)}`} onClick={() => start(a)}>
                <Play className="h-3 w-3" /> Start
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <FormStatus status={status} />
      </div>

      {active?.assessment.type === 'quiz' && <QuizForm attempt={active} onSubmit={finish} />}
      {active?.assessment.type === 'ai_viva' && <VivaForm attempt={active} onSubmit={finish} />}
      {active?.assessment.type === 'project' && <ProjectForm attempt={active} onSubmit={finish} />}
    </div>
  );
}

function QuizForm({ attempt, onSubmit }: { attempt: any; onSubmit: (b: any) => void }) {
  const [answers, setAnswers] = useState<number[]>(new Array(attempt.questions.length).fill(-1));
  return (
    <div className="mt-4 space-y-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
      {attempt.questions.map((q: any, i: number) => (
        <fieldset key={i}>
          <legend className="text-sm font-semibold text-foreground">
            {i + 1}. {q.prompt}
          </legend>
          <div className="mt-2 space-y-1.5">
            {q.options.map((opt: string, j: number) => (
              <label
                key={j}
                className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-sm transition-colors ${
                  answers[i] === j ? 'border-brand-400 bg-brand-500/10 text-foreground' : 'text-gray-600 hover:bg-brand-500/5'
                }`}
                style={answers[i] === j ? undefined : { borderColor: 'var(--border)' }}
              >
                <input
                  type="radio"
                  name={`q${i}`}
                  className="accent-blue-600"
                  checked={answers[i] === j}
                  onChange={() => setAnswers((prev) => prev.map((v, k) => (k === i ? j : v)))}
                />
                {opt}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <button className="btn" disabled={answers.includes(-1)} onClick={() => onSubmit({ answers })}>
        Submit quiz
      </button>
    </div>
  );
}

function VivaForm({ attempt, onSubmit }: { attempt: any; onSubmit: (b: any) => void }) {
  const [answer, setAnswer] = useState('');
  return (
    <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Mic className="h-4 w-4 text-brand-500" /> Viva question (AI-graded):
      </p>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">{attempt.question}</p>
      <div className="mt-3">
        <Field label="Your answer">
          {(ids) => <textarea {...ids} className="input" rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer in your own words…" />}
        </Field>
      </div>
      <button className="btn mt-3" disabled={answer.trim().length < 10} onClick={() => onSubmit({ answer })}>
        Submit answer
      </button>
    </div>
  );
}

function ProjectForm({ attempt, onSubmit }: { attempt: any; onSubmit: (b: any) => void }) {
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [progress, setProgress] = useState<{ fileName: string; state: UploadState } | null>(null);
  const [status, , setError, clearStatus] = useFormStatus();
  return (
    <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <FileUp className="h-4 w-4 text-brand-500" /> Project submission
      </p>
      {attempt.instructions && <p className="mt-2 text-sm leading-relaxed text-gray-600">{attempt.instructions}</p>}
      <div className="mt-3">
        <Field label="Project file">
          {(ids) => (
            <input
              {...ids}
              type="file"
              disabled={uploading}
              className="block w-full text-sm text-gray-500 file:mr-3 file:cursor-pointer file:rounded-xl file:border-0 file:bg-brand-500/10 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-brand-600 hover:file:bg-brand-500/20"
              onChange={async (e) => {
                const input = e.currentTarget;
                const file = input.files?.[0];
                if (!file) return;
                clearStatus();
                setUploaded(false);
                setProgress(null);
                if (file.size > attempt.max_bytes) {
                  setError(`This file is ${formatBytes(file.size)}; the limit is ${formatBytes(attempt.max_bytes)}. Compress it or upload a smaller file.`);
                  input.value = '';
                  return;
                }
                setUploading(true);
                try {
                  // The signed URL comes from the attempt; only a 2xx from storage means the file is there.
                  await putFile(attempt.upload_url, file, {
                    contentType: 'application/octet-stream',
                    onState: (state) => setProgress({ fileName: file.name, state }),
                  });
                  setUploaded(true);
                } catch (err) {
                  setProgress(null);
                  setError((err as Error).message);
                  // Clear the picker so choosing the same file again fires onChange.
                  input.value = '';
                } finally {
                  setUploading(false);
                }
              }}
            />
          )}
        </Field>
      </div>
      {progress && <UploadProgress fileName={progress.fileName} state={progress.state} />}
      <FormStatus status={status} />
      <button className="btn mt-3" disabled={!uploaded || uploading} onClick={() => onSubmit({ file_key: attempt.file_key })}>
        {uploading ? 'Uploading…' : 'Submit project'}
      </button>
    </div>
  );
}
