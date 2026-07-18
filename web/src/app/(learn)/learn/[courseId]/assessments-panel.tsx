'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface AssessmentSummary {
  id: string;
  type: 'quiz' | 'ai_viva' | 'project';
  is_required: boolean;
  pass_score: number;
  question_count?: number;
  written_count?: number;
  proctored?: boolean;
  time_limit_minutes?: number | null;
}

export function AssessmentsPanel({ courseId }: { courseId: string }) {
  const router = useRouter();
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
    if (assessment.type === 'quiz') {
      // Quizzes run in the dedicated exam room (proctoring, timer, written answers).
      router.push(`/learn/${courseId}/exam/${assessment.id}`);
      return;
    }
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
      <h3 className="font-semibold">Assessments</h3>
      <ul className="mt-2 space-y-2 text-sm">
        {assessments.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <span className="capitalize">
              {a.type.replace('_', ' ')}
              {a.type === 'quiz' && (
                <span className="ml-1 text-xs normal-case text-gray-500">
                  {a.question_count} Q{(a.written_count ?? 0) > 0 ? ` · ${a.written_count} written` : ''}
                  {a.proctored ? ' · 📹 proctored' : ''}
                  {a.time_limit_minutes ? ` · ⏱ ${a.time_limit_minutes} min` : ''}
                </span>
              )}{' '}
              {a.is_required && <span className="text-xs text-gray-400">(required for certificate)</span>}
            </span>
            {passed(a.id) ? (
              <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">Passed ✓</span>
            ) : (
              <button className="btn-secondary text-xs" onClick={() => start(a)}>
                {a.type === 'quiz' ? 'Start exam →' : 'Start'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {message && <p className="mt-3 text-sm text-brand-800">{message}</p>}

      {active?.assessment.type === 'ai_viva' && <VivaForm attempt={active} onSubmit={finish} />}
      {active?.assessment.type === 'project' && <ProjectForm attempt={active} onSubmit={finish} />}
    </div>
  );
}

function VivaForm({ attempt, onSubmit }: { attempt: any; onSubmit: (b: any) => void }) {
  const [answer, setAnswer] = useState('');
  return (
    <div className="mt-4 border-t pt-4">
      <p className="text-sm font-medium">🎤 Viva question (AI-graded):</p>
      <p className="mt-1 text-sm text-gray-700">{attempt.question}</p>
      <textarea className="input mt-2" rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer in your own words…" />
      <button className="btn mt-2" disabled={answer.trim().length < 10} onClick={() => onSubmit({ answer })}>
        Submit answer
      </button>
    </div>
  );
}

function ProjectForm({ attempt, onSubmit }: { attempt: any; onSubmit: (b: any) => void }) {
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  return (
    <div className="mt-4 border-t pt-4">
      <p className="text-sm font-medium">📁 Project submission</p>
      {attempt.instructions && <p className="mt-1 text-sm text-gray-700">{attempt.instructions}</p>}
      <input
        type="file"
        className="mt-2 text-sm"
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
      <button className="btn mt-2" disabled={!uploaded || uploading} onClick={() => onSubmit({ file_key: attempt.file_key })}>
        {uploading ? 'Uploading…' : 'Submit project'}
      </button>
    </div>
  );
}
