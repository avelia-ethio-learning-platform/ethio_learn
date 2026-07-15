'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, FileUp, Mic, Play } from 'lucide-react';
import { api } from '@/lib/api';

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
  const [message, setMessage] = useState('');

  if (!assessments?.length) return null;

  const passed = (assessmentId: string) => attempts?.some((a) => a.assessment_id === assessmentId && a.passed);

  const start = async (assessment: AssessmentSummary) => {
    setMessage('');
    try {
      const res = await api<any>(`/assessments/${assessment.id}/attempts`, { method: 'POST' });
      setActive({ ...res, assessment });
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  const finish = async (body: Record<string, unknown>) => {
    try {
      const res = await api<any>(`/attempts/${active.attempt_id}/submit`, { method: 'PUT', body });
      setMessage(
        res.pending_review
          ? 'Submitted — your educator will review it.'
          : `Score: ${res.score} — ${res.passed ? 'PASSED 🎉' : 'not passed yet'}${res.feedback ? ` · ${res.feedback}` : ''}`,
      );
      setActive(null);
      await queryClient.invalidateQueries({ queryKey: ['attempts', courseId] });
    } catch (err) {
      setMessage((err as Error).message);
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
            <span className="capitalize text-foreground">
              {a.type.replace('_', ' ')}{' '}
              {a.is_required && <span className="text-xs font-normal text-gray-400">(required for certificate)</span>}
            </span>
            {passed(a.id) ? (
              <span className="badge-success">
                <CheckCircle2 className="h-3 w-3" /> Passed
              </span>
            ) : (
              <button className="btn-secondary !px-3 !py-1 !text-xs" onClick={() => start(a)}>
                <Play className="h-3 w-3" /> Start
              </button>
            )}
          </li>
        ))}
      </ul>
      {message && <p className="mt-3 text-sm font-medium text-brand-600">{message}</p>}

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
        <div key={i}>
          <p className="text-sm font-semibold text-foreground">
            {i + 1}. {q.prompt}
          </p>
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
        </div>
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
      <textarea className="input mt-3" rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer in your own words…" />
      <button className="btn mt-3" disabled={answer.trim().length < 10} onClick={() => onSubmit({ answer })}>
        Submit answer
      </button>
    </div>
  );
}

function ProjectForm({ attempt, onSubmit }: { attempt: any; onSubmit: (b: any) => void }) {
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  return (
    <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <FileUp className="h-4 w-4 text-brand-500" /> Project submission
      </p>
      {attempt.instructions && <p className="mt-2 text-sm leading-relaxed text-gray-600">{attempt.instructions}</p>}
      <input
        type="file"
        className="mt-3 block w-full text-sm text-gray-500 file:mr-3 file:cursor-pointer file:rounded-xl file:border-0 file:bg-brand-500/10 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-brand-600 hover:file:bg-brand-500/20"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > attempt.max_bytes) {
            alert('File exceeds the 50MB limit.');
            return;
          }
          setUploading(true);
          await fetch(attempt.upload_url, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
          setUploading(false);
          setUploaded(true);
        }}
      />
      <button className="btn mt-3" disabled={!uploaded || uploading} onClick={() => onSubmit({ file_key: attempt.file_key })}>
        {uploading ? 'Uploading…' : 'Submit project'}
      </button>
    </div>
  );
}
