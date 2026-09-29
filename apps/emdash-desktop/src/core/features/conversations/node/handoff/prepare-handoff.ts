import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HandoffPreparation } from '@core/primitives/conversations/api';
import { readTranscript, type TranscriptTurn } from './transcript';

const execFileAsync = promisify(execFile);

/** Handoff files live in the workspace so the next agent reads them without a prompt. */
export const HANDOFF_DIR = '.emdash/handoffs';
const EXCLUDE_ENTRY = `/${HANDOFF_DIR}/`;

const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  'oh-my-pi': 'Oh My Pi',
  cursor: 'Cursor',
};

export type HandoffSource = {
  providerId: string;
  sessionId: string | null;
  cwd: string;
};

export type HandoffDeps = {
  readTranscript: typeof readTranscript;
  git: (cwd: string, args: string[]) => Promise<string>;
  now: () => Date;
};

const defaultDeps: HandoffDeps = {
  readTranscript,
  git: async (cwd, args) => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout.trimEnd();
    } catch {
      return '';
    }
  },
  now: () => new Date(),
};

/**
 * Prepares a handoff without spending the source agent's tokens (it may be out of quota):
 * the session's spoken turns go to a workspace file the next agent reads on demand, and
 * the first message stays small — the original ask, the last reply and the git state.
 * The receiving agent then rebuilds its own understanding from the code, in its own cache.
 */
export async function prepareHandoff(
  source: HandoffSource,
  deps: HandoffDeps = defaultDeps
): Promise<HandoffPreparation> {
  const agent = AGENT_NAMES[source.providerId] ?? source.providerId;
  const turns = source.sessionId
    ? await deps.readTranscript(source.providerId, source.sessionId, source.cwd)
    : [];

  let transcriptPath: string | null = null;
  if (turns.length > 0) {
    const stamp = deps.now().toISOString().slice(0, 19).replace(/:/g, '-');
    transcriptPath = `${HANDOFF_DIR}/${stamp}-${source.providerId}.md`;
    await mkdir(path.join(source.cwd, HANDOFF_DIR), { recursive: true });
    await writeFile(path.join(source.cwd, transcriptPath), renderTranscript(agent, turns));
    await ensureGitExcluded(source.cwd, deps);
  }

  const [status, diffStat, log] = await Promise.all([
    deps.git(source.cwd, ['status', '--short']),
    deps.git(source.cwd, ['diff', '--stat', 'HEAD']),
    deps.git(source.cwd, ['log', '--oneline', '-5']),
  ]);

  // A session drifts: later asks change the goal, so the recent turns lead and the first
  // ask is only background.
  const firstAsk = turns.find((turn) => turn.role === 'user')?.text;
  const recent = recentTurns(turns);
  const sections = [
    `你在接手另一个 AI 编码助手（${agent}）没做完的工作。项目目录和代码改动是同一份，已经在你的工作目录里。`,
  ];
  if (recent.length > 0) {
    sections.push(
      [
        '## 最近的对话（当前在做什么以这里为准）',
        '',
        '任务在过程中可能已经换了方向，最后几条用户消息才是现在的目标。',
        '',
        ...recent.map(
          (turn) =>
            `### ${turn.role === 'user' ? '用户' : agent}\n\n${clip(turn.text, turn.role === 'user' ? RECENT_USER_CHARS : RECENT_REPLY_CHARS)}`
        ),
      ].join('\n')
    );
  }
  if (firstAsk && !recent.some((turn) => turn.role === 'user' && turn.text === firstAsk)) {
    sections.push(`## 最初的需求（仅作背景，之后可能已经改变）\n\n${clip(firstAsk, 600)}`);
  }
  sections.push(
    [
      '## 当前代码状态',
      '',
      '```',
      '$ git status --short',
      limitLines(status, 40) || '（没有未提交的改动）',
      '',
      '$ git diff --stat HEAD',
      limitLines(diffStat, 30) || '（无）',
      '',
      '$ git log --oneline -5',
      log || '（无）',
      '```',
    ].join('\n')
  );
  sections.push(
    transcriptPath
      ? `## 完整对话记录\n\n\`${transcriptPath}\`（共 ${turns.length} 段，只含双方的文字，工具调用和输出已去掉）。需要细节时再按需读取，通常先看末尾几段就够了。`
      : '## 完整对话记录\n\n原会话没有可读取的对话记录，请以代码和 git 历史为准。'
  );
  sections.push(
    '先用 git diff 核对实际改动，再用几句话说明你理解的当前目标（以最近的对话为准）、进度和下一步，然后继续完成任务。拿不准当前目标时，先读对话记录的末尾几段，还不清楚就先问用户。'
  );
  return { prompt: sections.join('\n\n'), transcriptPath };
}

/** How many of the last user messages (with the replies between them) lead the handoff. */
const RECENT_USER_TURNS = 4;
const RECENT_USER_CHARS = 1200;
const RECENT_REPLY_CHARS = 1500;

/**
 * The tail of the conversation from the last few user messages on. Replies before the
 * last one are only a line of context each, so the handoff message stays short.
 */
function recentTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
  let users = 0;
  let start = turns.length;
  while (start > 0 && users < RECENT_USER_TURNS) {
    start -= 1;
    if (turns[start]!.role === 'user') users += 1;
  }
  const tail = turns.slice(start);
  const lastReply = tail.map((turn) => turn.role).lastIndexOf('assistant');
  return tail.map((turn, index) =>
    turn.role === 'assistant' && index !== lastReply
      ? { ...turn, text: clip(turn.text, 400) }
      : turn
  );
}

function renderTranscript(agent: string, turns: TranscriptTurn[]): string {
  const body = turns
    .map((turn) => `## ${turn.role === 'user' ? '用户' : agent}\n\n${clip(turn.text, 8000)}`)
    .join('\n\n');
  return `# 与 ${agent} 的对话记录（交接用）\n\n${body}\n`;
}

/** Keeps handoff files out of `git status` via the local, uncommitted exclude file. */
async function ensureGitExcluded(cwd: string, deps: HandoffDeps): Promise<void> {
  const excludePath = await deps.git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  if (!excludePath) return;
  const file = path.resolve(cwd, excludePath);
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    await mkdir(path.dirname(file), { recursive: true });
  }
  if (current.split('\n').some((line) => line.trim() === EXCLUDE_ENTRY)) return;
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  await appendFile(file, `${prefix}${EXCLUDE_ENTRY}\n`);
}

/** Long messages keep their start and end, where the ask and the outcome usually are. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n…（中间省略 ${text.length - max} 字）…\n\n${text.slice(-half)}`;
}

function limitLines(text: string, max: number): string {
  const lines = text.split('\n');
  return lines.length <= max
    ? text
    : [...lines.slice(0, max), `…（另有 ${lines.length - max} 行）`].join('\n');
}
