param($procId, $out, $label)
$c = @(Get-NetTCPConnection -OwningProcess ([int]$procId) -ErrorAction SilentlyContinue)
foreach ($x in $c) { "[$label] tcp $($x.RemoteAddress):$($x.RemotePort) $($x.State)" }
"[$label] tcp count: $($c.Count)"
