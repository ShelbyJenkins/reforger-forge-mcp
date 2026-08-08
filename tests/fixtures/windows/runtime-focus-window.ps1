[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$OwnerTokenArgument,
	[ValidateRange(0, 60000)][int]$FirstWindowDelayMs = 0,
	[ValidateRange(0, 60000)][int]$ReplacementDelayMs = 250,
	[ValidateRange(1000, 120000)][int]$LifetimeMs = 5000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$started = [Environment]::TickCount64
$first = $null
$replacement = $null
$nextAllocation = $started
try
{
	while (([Environment]::TickCount64 - $started) -lt $LifetimeMs)
	{
		$elapsed = [Environment]::TickCount64 - $started
		if ($null -eq $first -and $elapsed -ge $FirstWindowDelayMs)
		{
			$first = [Windows.Forms.Form]::new()
			$first.Text = "RFO focus fixture first $OwnerTokenArgument"
			$first.Size = [Drawing.Size]::new(320, 160)
			$first.Show()
			[void]$first.Activate()
		}
		if ($null -ne $first -and $null -eq $replacement -and
			$elapsed -ge ($FirstWindowDelayMs + $ReplacementDelayMs))
		{
			$first.Close()
			$replacement = [Windows.Forms.Form]::new()
			$replacement.Text = "RFO focus fixture replacement $OwnerTokenArgument"
			$replacement.Size = [Drawing.Size]::new(360, 180)
			$replacement.Show()
			[void]$replacement.Activate()
		}
		if ([Environment]::TickCount64 -ge $nextAllocation)
		{
			# Exercise the helper callback while both processes experience GC pressure.
			$garbage = [Collections.Generic.List[byte[]]]::new()
			for ($index = 0; $index -lt 64; $index++) { $garbage.Add((New-Object byte[] 65536)) }
			[GC]::Collect(0, [GCCollectionMode]::Forced)
			$nextAllocation = [Environment]::TickCount64 + 100
		}
		[Windows.Forms.Application]::DoEvents()
		Start-Sleep -Milliseconds 5
	}
}
finally
{
	if ($null -ne $replacement) { $replacement.Close(); $replacement.Dispose() }
	if ($null -ne $first) { $first.Close(); $first.Dispose() }
}
