// Which of a turn's texts is its answer (the report the master and the notices get).
//
// 1. A marked report: our agents are told (REPORT_HINT, in their system prompt) to put their final report
//    between a line "[[FLEET-REPORT]]" and a line "[[/FLEET-REPORT]]". The last such block of the turn wins,
//    wherever it is (also one rewritten after a stop hook).
// 2. Else the answer as it stood when the turn first ended: the texts after its last tool call, before a
//    stop hook sent it back to work. A stop hook (e.g. project-docs asking about the docs) makes the agent
//    go on and say one more thing ("no docs to update"), which used to be told as the answer instead of
//    the report before it. What comes after a stop hook counts only when nothing came before it.
// The transcript marks a stop hook's feedback as a user message (isMeta) "Stop hook feedback:\n…".

export const REPORT_OPEN = '[[FLEET-REPORT]]';
export const REPORT_CLOSE = '[[/FLEET-REPORT]]';

/** Added to our agents' system prompt (with the fleet-open hint). */
export const REPORT_HINT = `When you finish a task you were given, write your final report (the conclusion, what you changed, how you checked it, what is left for the user) between a line "${REPORT_OPEN}" and a line "${REPORT_CLOSE}", as the last thing of your answer. Fleet Bridge forwards that block to whoever gave the task. One block per task; if you have to say something after it (e.g. answering a hook), keep that outside the block, and only write a new block when the report itself changed.`;

const BLOCK = /\[\[FLEET-REPORT\]\]([\s\S]*?)(?:\[\[\/FLEET-REPORT\]\]|$)/g;

/** The last report block in a text (its content, trimmed), or ''. An unclosed block runs to the end. */
export function reportBlock(text) {
  let last = '';
  for (const m of String(text || '').matchAll(BLOCK)) if (m[1].trim()) last = m[1].trim();
  return last;
}

const textsOf = (content) => (typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => String(c.text || '')) : []);

/** A stop hook's feedback, sending the agent back to work after it had ended its turn. */
export function isStopHook(e) {
  return e?.type === 'user' && textsOf(e.message?.content).some((t) => /^Stop hook feedback:/.test(t.trim()));
}

/**
 * The answer of one turn, from its transcript entries in order (only this turn's; API errors left to the caller).
 * @returns {{ reply: string, marked: boolean, afterHook: boolean }} marked: it came from a report block;
 *   afterHook: it is what the agent said after a stop hook (nothing came before it)
 */
export function pickReply(entries) {
  let block = '';
  let hooked = false;
  const before = { run: [], last: '' }; // texts since the last tool call, and the last of them seen
  const after = { run: [], last: '' };
  for (const e of entries || []) {
    if (e?.isSidechain) continue; // a subagent's own conversation
    if (isStopHook(e)) {
      hooked = true;
      continue;
    }
    if (e?.type !== 'assistant' || e.isApiErrorMessage || !Array.isArray(e.message?.content)) continue;
    const side = hooked ? after : before;
    for (const c of e.message.content) {
      if (c?.type === 'tool_use') {
        if (side.run.length) side.last = side.run.join('\n\n');
        side.run = [];
      } else if (c?.type === 'text' && c.text?.trim()) {
        const t = c.text.trim();
        side.run.push(t);
        const b = reportBlock(t);
        if (b) block = b;
      }
    }
  }
  if (block) return { reply: block, marked: true, afterHook: false };
  const pre = before.run.length ? before.run.join('\n\n') : before.last;
  if (pre) return { reply: pre, marked: false, afterHook: false };
  const post = after.run.length ? after.run.join('\n\n') : after.last;
  return { reply: post, marked: false, afterHook: Boolean(post) };
}
