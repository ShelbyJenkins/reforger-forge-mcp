#Requires -Version 5.1
<#
.SYNOPSIS
  Starts, verifies, or describes one ReforgerForge MCP stdio command.

.DESCRIPTION
  Serve is the default and is intended only as an MCP client's stdio command.
  Verify runs the bounded fresh-process MCP verifier with the exact same server
  arguments. Describe validates the local launcher inputs and writes one JSON
  descriptor without starting the MCP server or Workbench.
#>

[CmdletBinding()]
param(
    [ValidateSet("Serve", "Verify", "Describe")]
    [string]$Mode = "Serve",

    [string[]]$WorkbenchAddonDir = @(),

    [string[]]$ObserverEvidenceRoot = @(),

    [string[]]$ObserverSupportingLogRoot = @(),

    [switch]$WorkbenchScriptAuthorizeAll
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ServerPath = [System.IO.Path]::GetFullPath((Join-Path $Root "dist\index.js"))
$VerifierPath = [System.IO.Path]::GetFullPath(
    (Join-Path $Root "scripts\verify-mcp-server.mjs")
)

function Resolve-LauncherFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-LauncherDirectories {
    param(
        [string[]]$Paths,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [switch]$RejectComma
    )

    $resolved = @()
    foreach ($path in @($Paths)) {
        if ([string]::IsNullOrWhiteSpace($path)) {
            throw "$Label must be a non-empty directory path."
        }
        if ($RejectComma -and $path.Contains(",")) {
            throw "$Label cannot contain a comma: $path"
        }
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            throw "$Label must resolve to an existing directory: $path"
        }
        $canonical = (Resolve-Path -LiteralPath $path).Path
        if ($resolved -notcontains $canonical) {
            $resolved += $canonical
        }
    }
    return @($resolved)
}

function Resolve-CompatibleNode {
    $candidates = @()
    $explicitNode = $env:REFORGER_FORGE_NODE_PATH
    if (-not [string]::IsNullOrWhiteSpace($explicitNode)) {
        # An explicit override is authoritative. Falling through to another
        # installation would make a client registration behave unpredictably.
        $candidates += $explicitNode
    }
    else {
        $pathNode = Get-Command "node.exe" -CommandType Application `
            -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $pathNode) {
            $candidates += $pathNode.Source
        }
        if ($env:ProgramFiles) {
            $candidates += Join-Path $env:ProgramFiles "nodejs\node.exe"
        }
        if (${env:ProgramFiles(x86)}) {
            $candidates += Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"
        }
    }

    $attempts = @()
    $visited = @()
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        $absolute = [System.IO.Path]::GetFullPath($candidate)
        if ($visited -contains $absolute) {
            continue
        }
        $visited += $absolute
        if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) {
            $attempts += "$absolute (missing)"
            continue
        }

        try {
            $versionOutput = @(& $absolute --version 2>$null)
            $versionExitCode = $LASTEXITCODE
            $version = ($versionOutput -join "").Trim()
            if ($versionExitCode -eq 0 -and $version -match '^v(?<major>\d+)\.') {
                $major = [int]$Matches.major
                if ($major -ge 24) {
                    return [ordered]@{
                        path = (Resolve-Path -LiteralPath $absolute).Path
                        version = $version
                        major = $major
                    }
                }
                $attempts += "$absolute ($version is older than v24)"
                continue
            }
            $attempts += "$absolute (did not report a valid Node.js version)"
        }
        catch {
            $attempts += "$absolute (could not execute)"
        }
    }

    $detail = if ($attempts.Count -gt 0) {
        " Checked: $($attempts -join '; ')."
    }
    else {
        ""
    }
    throw "Node.js 24 LTS or newer was not found.$detail Install Node.js 24+ or set REFORGER_FORGE_NODE_PATH to a compatible executable."
}

try {
    $ServerPath = Resolve-LauncherFile -Path $ServerPath -Label "Built MCP server"
    $VerifierPath = Resolve-LauncherFile -Path $VerifierPath -Label "MCP verifier"
    $Node = Resolve-CompatibleNode

    $AddonDirectories = @(Resolve-LauncherDirectories `
        -Paths $WorkbenchAddonDir `
        -Label "Workbench add-on root" `
        -RejectComma)
    $EvidenceRoots = @(Resolve-LauncherDirectories `
        -Paths $ObserverEvidenceRoot `
        -Label "Observer evidence root")
    $SupportingLogRoots = @(Resolve-LauncherDirectories `
        -Paths $ObserverSupportingLogRoot `
        -Label "Observer supporting-log root")

    $ServerArguments = @()
    foreach ($path in $AddonDirectories) {
        $ServerArguments += "--workbench-addon-dir", $path
    }
    if ($WorkbenchScriptAuthorizeAll) {
        $ServerArguments += "--workbench-script-authorize-all"
    }
    foreach ($path in $EvidenceRoots) {
        $ServerArguments += "--observer-evidence-root", $path
    }
    foreach ($path in $SupportingLogRoots) {
        $ServerArguments += "--observer-supporting-log-root", $path
    }

    if ($Mode -eq "Describe") {
        $descriptor = [ordered]@{
            schemaVersion = 1
            mode = "Describe"
            command = $Node.path
            nodeVersion = $Node.version
            serverPath = $ServerPath
            verifierPath = $VerifierPath
            startupArguments = @($ServerArguments)
        }
        [Console]::Out.WriteLine(($descriptor | ConvertTo-Json -Depth 4))
        return
    }

    if ($Mode -eq "Verify") {
        & $Node.path $VerifierPath @ServerArguments
        exit $LASTEXITCODE
    }

    # Serve writes no launcher diagnostics to stdout: stdout is the MCP stdio
    # protocol stream owned by the client that started this process.
    & $Node.path $ServerPath @ServerArguments
    exit $LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine(
        "ReforgerForge MCP launcher failed: $($_.Exception.Message)"
    )
    exit 1
}
