param($procId, $out, $label)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class R {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string s);
}
"@
$target = [uint32]$procId
$script:lines = New-Object System.Collections.Generic.List[string]
[R]::EnumWindows({ param($h, $l)
  $p = 0; [void][R]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $target -and [R]::IsWindowVisible($h)) { $script:lines.Add("[$label] SetWindowText $h -> $([R]::SetWindowText($h, 'Dungeon Blitz: R'))") }
  $true }, [IntPtr]::Zero) | Out-Null
$script:lines
"[$label] windows found: $($script:lines.Count)"
