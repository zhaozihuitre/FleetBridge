// Voice input through Windows' own voice typing (Win+H): it types what you say into the focused
// text box, in the language Windows is set up for, with nothing to install or pay for.
// The page focuses the box first; here we only press Win+H. Electron can't send OS-level keys, so a
// hidden PowerShell keeps running and presses them through user32 when it reads a line from us
// (started once: compiling the helper takes about a second, a fresh process per press would lag).
const { spawn } = require('node:child_process');

const SCRIPT = `
Add-Type -Namespace FB -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  [FB.Keys]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)   # Win down
  [FB.Keys]::keybd_event(0x48, 0, 0, [UIntPtr]::Zero)   # H down
  [FB.Keys]::keybd_event(0x48, 0, 2, [UIntPtr]::Zero)   # H up
  [FB.Keys]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)   # Win up
}`;

let ps = null;

function helper() {
  if (ps && ps.exitCode === null && !ps.killed) return ps;
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  ps.on('error', () => (ps = null));
  ps.on('exit', () => (ps = null));
  return ps;
}

/** Start the helper ahead of time, so the first press isn't slow. */
function warmVoice() {
  if (process.platform === 'win32') helper();
}

/** Open Windows voice typing on whatever has the keyboard focus. */
function startVoice() {
  if (process.platform !== 'win32') return false;
  const p = helper();
  if (!p?.stdin?.writable) return false;
  p.stdin.write('h\n');
  return true;
}

function stopVoice() {
  try {
    ps?.kill();
  } catch {
    // already gone
  }
  ps = null;
}

module.exports = { warmVoice, startVoice, stopVoice };
