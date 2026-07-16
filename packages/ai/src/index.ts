/**
 * AI capabilities backed by Groq (OpenAI-compatible chat completions).
 * Used for: AI viva question generation + grading, quiz generation, course
 * structure generation from source material, and plagiarism/spam screening.
 *
 * `createAiAssessor()` returns the Groq implementation when a real GROQ_API_KEY
 * is configured, otherwise a deterministic offline mock so the whole platform
 * runs locally with zero external credentials.
 */

export interface VivaEvaluation {
  score: number; // 0-100
  feedback: string;
}

export interface WrittenGrade {
  score: number; // 0-100
  feedback: string;
}

export interface PlagiarismResult {
  similarity_score: number; // 0-100
  flagged: boolean;
  reason: string;
}

export interface QuizQuestion {
  prompt: string;
  options: string[];
  correct_index: number;
}

export interface GeneratedLesson {
  title: string;
  summary?: string;
}

export interface GeneratedSection {
  title: string;
  is_free_preview: boolean;
  lessons: GeneratedLesson[];
}

export interface CourseStructureInput {
  title: string;
  source_text?: string;
  prompt?: string;
  section_count: number;
  lessons_per_section: number;
  /** Target learner level: beginner | intermediate | advanced. */
  level?: string;
  /** Preferred learning style, e.g. hands-on / project-based / theory-first / visual. */
  learning_style?: string;
}

export interface AiAssessor {
  generateVivaQuestion(courseTitle: string, topicContext: string): Promise<string>;
  evaluateVivaAnswer(question: string, answer: string): Promise<VivaEvaluation>;
  /** Grade an exam written answer against the question (and optional educator guidance). */
  gradeWrittenAnswer(question: string, answer: string, guidance?: string, courseTitle?: string): Promise<WrittenGrade>;
  /** Screen a listing for spam / fabrication and near-duplication of `corpus` (existing catalog). */
  plagiarismCheck(title: string, description: string, corpus?: string[]): Promise<PlagiarismResult>;
  /** Generate `count` multiple-choice questions on a topic. */
  generateQuiz(topic: string, count: number, difficulty?: string): Promise<QuizQuestion[]>;
  /** Organize source material / a prompt into an ordered course outline. */
  generateCourseStructure(input: CourseStructureInput): Promise<{ sections: GeneratedSection[] }>;
  /** Whether this is a real AI backend (vs the offline mock). */
  readonly isLive: boolean;
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

function groqConfigured(): boolean {
  const key = process.env.GROQ_API_KEY;
  return !!key && key !== 'gsk_REPLACE_ME' && key.startsWith('gsk_');
}

export class MockAiAssessor implements AiAssessor {
  readonly isLive = false;

  async generateVivaQuestion(courseTitle: string, topicContext: string): Promise<string> {
    return `In your own words, explain the most important concept from "${courseTitle}"${topicContext ? ` (${topicContext.slice(0, 80)})` : ''}. Describe how you would apply it to a real problem in Ethiopia.`;
  }

  async evaluateVivaAnswer(_question: string, answer: string): Promise<VivaEvaluation> {
    const words = answer.trim().split(/\s+/).filter(Boolean).length;
    const score = Math.min(100, Math.round((words / 60) * 100));
    return {
      score,
      feedback:
        score >= 60
          ? '[mock evaluator] Substantive answer demonstrating engagement with the material.'
          : '[mock evaluator] Answer too brief — explain the concept in more depth.',
    };
  }

  async gradeWrittenAnswer(question: string, answer: string, guidance?: string): Promise<WrittenGrade> {
    const words = answer.trim().split(/\s+/).filter(Boolean).length;
    // Offline heuristic: length + naive keyword overlap with the question/guidance.
    const keywords = `${question} ${guidance ?? ''}`.toLowerCase().match(/[a-z]{5,}/g) ?? [];
    const hit = keywords.filter((k) => answer.toLowerCase().includes(k)).length;
    const overlap = keywords.length ? hit / keywords.length : 0.5;
    const score = Math.min(100, Math.round(Math.min(1, words / 40) * 60 + overlap * 40));
    return {
      score,
      feedback:
        score >= 60
          ? '[mock grader] Answer addresses the question with reasonable depth.'
          : '[mock grader] Answer is too brief or off-topic — address the question directly and in more depth.',
    };
  }

  async plagiarismCheck(title: string, _description: string, corpus: string[] = []): Promise<PlagiarismResult> {
    // Offline heuristic: flag a near-identical title already in the catalog.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const t = norm(title);
    const dup = corpus.map(norm).find((c) => c && (c === t || c.includes(t) || t.includes(c)) && Math.min(c.length, t.length) > 6);
    if (dup) return { similarity_score: 85, flagged: true, reason: `[offline] Title closely matches an existing course ("${dup}").` };
    return { similarity_score: 4, flagged: false, reason: '[offline] no similarity detected' };
  }

  async generateQuiz(topic: string, count: number): Promise<QuizQuestion[]> {
    const n = Math.max(1, Math.min(count, 20));
    return Array.from({ length: n }, (_, i) => ({
      prompt: `[mock Q${i + 1}] Which statement about "${topic}" is correct?`,
      options: ['A plausible but wrong option', `The correct fact about ${topic}`, 'Another wrong option', 'Yet another wrong option'],
      correct_index: 1,
    }));
  }

  async generateCourseStructure(input: CourseStructureInput): Promise<{ sections: GeneratedSection[] }> {
    const sections: GeneratedSection[] = Array.from({ length: Math.max(1, Math.min(input.section_count, 12)) }, (_, s) => ({
      title: `Section ${s + 1}: ${input.title} — part ${s + 1}`,
      is_free_preview: s === 0,
      lessons: Array.from({ length: Math.max(1, Math.min(input.lessons_per_section, 12)) }, (_, l) => ({
        title: `Lesson ${s + 1}.${l + 1}`,
        summary: '[mock] Draft lesson — edit before saving.',
      })),
    }));
    return { sections };
  }
}

export class GroqAiAssessor implements AiAssessor {
  readonly isLive = true;
  private readonly model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

  private async chat(system: string, user: string, json = true): Promise<string> {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.4,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Groq request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('Groq returned no content');
    return content.trim();
  }

  private parseJson<T>(raw: string): T {
    // Models occasionally wrap JSON in prose or code fences — extract defensively.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : raw;
    const start = candidate.search(/[[{]/);
    const slice = start >= 0 ? candidate.slice(start) : candidate;
    return JSON.parse(slice) as T;
  }

  async generateVivaQuestion(courseTitle: string, topicContext: string): Promise<string> {
    const raw = await this.chat(
      'You are an oral examiner for an Ethiopian online learning platform. Reply with JSON {"question": "..."} — one open-ended question testing genuine understanding, no preamble.',
      `Course: ${courseTitle}\nTopic context: ${topicContext}`,
    );
    return this.parseJson<{ question: string }>(raw).question;
  }

  async evaluateVivaAnswer(question: string, answer: string): Promise<VivaEvaluation> {
    const raw = await this.chat(
      'You grade oral-exam answers. Reply with JSON {"score": 0-100, "feedback": "one short paragraph addressed to the learner"}.',
      `Question: ${question}\n\nLearner answer: ${answer}`,
    );
    const p = this.parseJson<VivaEvaluation>(raw);
    return { score: Math.max(0, Math.min(100, Math.round(p.score))), feedback: p.feedback };
  }

  async gradeWrittenAnswer(question: string, answer: string, guidance?: string, courseTitle?: string): Promise<WrittenGrade> {
    const raw = await this.chat(
      'You grade written exam answers strictly but fairly. Award marks for correctness, completeness and understanding — not length. Reply with JSON {"score": 0-100, "feedback": "2-3 sentences addressed to the learner explaining the mark and what a full answer needed"}.',
      `${courseTitle ? `Course: ${courseTitle}\n` : ''}Exam question: ${question}\n${guidance ? `Educator marking guidance (what a good answer covers): ${guidance}\n` : ''}\nLearner's answer:\n${answer.slice(0, 6000)}`,
    );
    const p = this.parseJson<WrittenGrade>(raw);
    return { score: Math.max(0, Math.min(100, Math.round(p.score))), feedback: p.feedback };
  }

  async plagiarismCheck(title: string, description: string, corpus: string[] = []): Promise<PlagiarismResult> {
    const catalog = corpus.length
      ? `\n\nExisting courses already on this platform (flag if the submission is a near-duplicate of any):\n${corpus.slice(0, 60).map((c) => `- ${c}`).join('\n')}`
      : '';
    const raw = await this.chat(
      'You screen online-course listings for spam, keyword stuffing, fabricated claims, content copied from well-known courses, AND near-duplication of the existing platform catalog provided. Reply with JSON {"similarity_score": 0-100, "flagged": bool (true if score > 70, a clear duplicate, or clearly spam), "reason": "one sentence explaining the decision"}.',
      `Course title: ${title}\n\nDescription: ${description}${catalog}`,
    );
    return this.parseJson<PlagiarismResult>(raw);
  }

  async generateQuiz(topic: string, count: number, difficulty = 'mixed'): Promise<QuizQuestion[]> {
    const n = Math.max(1, Math.min(count, 20));
    const raw = await this.chat(
      `You write multiple-choice quiz questions. Reply with JSON {"questions": [{"prompt": "...", "options": ["...","...","...","..."], "correct_index": 0}]}. Exactly ${n} questions, ${difficulty} difficulty, each with 3-4 options and exactly one correct answer (correct_index is 0-based).`,
      `Topic: ${topic}`,
    );
    const parsed = this.parseJson<{ questions: QuizQuestion[] }>(raw);
    return (parsed.questions ?? []).slice(0, n).map((q) => ({
      prompt: q.prompt,
      options: q.options,
      correct_index: Math.max(0, Math.min(q.correct_index ?? 0, (q.options?.length ?? 1) - 1)),
    }));
  }

  async generateCourseStructure(input: CourseStructureInput): Promise<{ sections: GeneratedSection[] }> {
    const sc = Math.max(1, Math.min(input.section_count, 12));
    const lc = Math.max(1, Math.min(input.lessons_per_section, 12));
    const level = input.level ? `Target learner level: ${input.level}. ` : '';
    const style = input.learning_style ? `Preferred learning style: ${input.learning_style} — shape lesson titles accordingly. ` : '';
    const raw = await this.chat(
      `You design online course outlines. Reply with JSON {"sections": [{"title": "...", "is_free_preview": bool, "lessons": [{"title": "...", "summary": "one sentence"}]}]}. Produce about ${sc} sections with about ${lc} lessons each. Mark ONLY the first section is_free_preview:true. ${level}${style}Base the outline on the provided material and prompt, sequencing lessons pedagogically from foundations to mastery.`,
      `Course title: ${input.title}\nEducator prompt: ${input.prompt ?? '(none)'}\n\nSource material:\n${(input.source_text ?? '').slice(0, 12000)}`,
    );
    const parsed = this.parseJson<{ sections: GeneratedSection[] }>(raw);
    const sections = (parsed.sections ?? []).slice(0, sc).map((s, i) => ({
      title: s.title,
      is_free_preview: i === 0,
      lessons: (s.lessons ?? []).slice(0, lc).map((l) => ({ title: l.title, summary: l.summary })),
    }));
    return { sections: sections.length ? sections : (await new MockAiAssessor().generateCourseStructure(input)).sections };
  }
}

export function createAiAssessor(): AiAssessor {
  return groqConfigured() ? new GroqAiAssessor() : new MockAiAssessor();
}
