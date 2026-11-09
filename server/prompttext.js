// A prompt as one readable line for the cards, lists and notices ("执行中：…"): the markup Claude Code wraps
// around parts of a prompt is dropped (pasted text keeps its words, a slash command shows as "/name args"),
// and a prompt that is only markup (a command's output, a system note) gives null.
const PASTE = /<\/?pasted_content\b[^>]*>/gi;
const COMMAND = /<command-name>\s*([^<]*?)\s*<\/command-name>/i;
const ARGS = /<command-args>\s*([^<]*?)\s*<\/command-args>/i;
const NOISE = /<(command-message|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr)\b[^>]*>[\s\S]*?<\/\1>/gi;

export function promptLine(s, max = 140) {
  if (typeof s !== 'string') return null;
  let text = s;
  const cmd = text.match(COMMAND);
  if (cmd) text = [cmd[1], text.match(ARGS)?.[1]].filter(Boolean).join(' ');
  text = text.replace(NOISE, '').replace(PASTE, '').replace(/<\/?[a-z]+[-_][\w-]*(\s[^>]*)?>/gi, ''); // other wrappers (kebab/snake names), not "<div>" in a prompt
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // a short lead-in ("用户新需求：", "Please:") says nothing alone: the next line goes with it
  let line = lines[0] || '';
  if (lines[1] && line.length <= 20 && /[:：]$/.test(line)) line += ' ' + lines[1];
  if (!line) return null;
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
