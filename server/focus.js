import { execFile } from 'node:child_process';

// Walks up from the Claude process to the first ancestor that owns a window (usually the
// terminal) and brings it to the front. Windows Terminal tabs can't be selected from outside,
// so this lands on the right window, not necessarily the right tab.
const SCRIPT = `
param([int]$TargetPid)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
"@
$id = $TargetPid
for ($i = 0; $i -lt 12 -and $id; $i++) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) {
    $h = $p.MainWindowHandle
    if ([W]::IsIconic($h)) { [W]::ShowWindow($h, 9) | Out-Null }
    [W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [W]::SetForegroundWindow($h) | Out-Null
    Write-Output $p.ProcessName; exit 0
  }
  $id = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").ParentProcessId
}
exit 1
`;

export function focusProcess(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'unsupported_platform' });
    const block = `& { ${SCRIPT} } -TargetPid ${Number(pid)}`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', block], { timeout: 15_000, windowsHide: true }, (err, stdout) =>
      resolve(err ? { ok: false, error: 'no_window_found' } : { ok: true, window: stdout.trim() }),
    );
  });
}
