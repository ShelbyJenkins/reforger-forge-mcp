#Requires -Version 5.1
<#
.SYNOPSIS
  Builds, verifies, registers, or diagnoses ReforgerForge MCP.

.DESCRIPTION
  With no switches, setup installs dependencies for a source checkout, builds
  once, verifies once, and registers every detected supported MCP client.

  -Doctor runs non-destructive diagnostics without installing, building, or
  registering. -CheckWorkbench adds one direct read-only NET API ping and is
  valid only with -Doctor. -Json writes one canonical receipt to stdout while
  operational messages remain on stderr.

  Custom server settings and client-specific recovery remain outside this
  happy-path script.
#>

param(
    [switch]$Doctor,
    [switch]$CheckWorkbench,
    [switch]$Json
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ServerPath = [System.IO.Path]::GetFullPath((Join-Path $Root "dist\index.js"))
$script:NodePath = "node"
$script:NodeVersion = "unavailable"

function Write-SetupMessage {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Message,

        [System.ConsoleColor]$Color
    )

    if ($Json) {
        [Console]::Error.WriteLine($Message)
    }
    elseif ($PSBoundParameters.ContainsKey("Color")) {
        Write-Host $Message -ForegroundColor $Color
    }
    else {
        Write-Host $Message
    }
}

function New-SetupLevel {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Status,

        [Parameter(Mandatory = $true)]
        [string]$Detail
    )

    return [ordered]@{
        status = $Status
        detail = $Detail
        issues = @()
    }
}

function New-CoreSetupFailureReceipt {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "platform",
            "package",
            "runtime",
            "dependencies",
            "build",
            "verification",
            "registration",
            "doctor"
        )]
        [string]$Layer,

        [Parameter(Mandatory = $true)]
        [string]$Message,

        [Parameter(Mandatory = $true)]
        [string]$ManualAction
    )

    $operation = if ($Doctor) { "doctor" } else { "setup" }
    $operationLabel = if ($Doctor) { "Doctor" } else { "Setup" }
    $serverPresent = Test-Path -LiteralPath $ServerPath -PathType Leaf
    $workbenchLevel = if ($Doctor -and $CheckWorkbench) {
        New-SetupLevel `
            -Status "not_run" `
            -Detail "Doctor stopped before the requested read-only Workbench check."
    }
    else {
        New-SetupLevel `
            -Status "not_tested" `
            -Detail "Live Workbench connectivity was not requested."
    }
    return [ordered]@{
        schemaVersion = 1
        operation = $operation
        overallStatus = "failed"
        runtime = [ordered]@{
            serverPath = $ServerPath
            serverPresent = $serverPresent
            nodePath = $script:NodePath
            nodeVersion = $script:NodeVersion
            serverVersion = $null
            transport = "stdio"
        }
        settings = [ordered]@{
            configPath = $null
            projectPath = $null
            gamePath = $null
            workbenchPath = $null
            workbenchAddonDirs = @()
            startupArguments = @()
            steamCandidates = [ordered]@{
                game = @()
                workbench = @()
            }
        }
        verification = [ordered]@{
            steamDiscovery = New-SetupLevel `
                -Status "not_run" `
                -Detail "$operationLabel stopped before Steam discovery."
            effectiveSettings = New-SetupLevel `
                -Status "not_run" `
                -Detail "$operationLabel stopped before settings validation."
            serverHandshake = New-SetupLevel `
                -Status "not_run" `
                -Detail "$operationLabel stopped before the MCP handshake."
            toolRegistration = New-SetupLevel `
                -Status "not_run" `
                -Detail "$operationLabel stopped before tool inspection."
            clientRegistration = New-SetupLevel `
                -Status "not_run" `
                -Detail "$operationLabel stopped before client registration."
            workbenchNetApi = $workbenchLevel
            observerCapture = New-SetupLevel `
                -Status "not_tested" `
                -Detail "Observer capture was not requested."
        }
        clients = @()
        modifiedFiles = @()
        managedChanges = @()
        backups = @()
        skipped = @()
        ambiguous = @()
        nextActions = @($ManualAction)
        failure = [ordered]@{
            layer = $Layer
            message = $Message
        }
    }
}

function ConvertTo-SetupStatusLabel {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Status
    )

    return $Status.Replace("_", " ")
}

function Format-SetupLevel {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Level
    )

    $result = ConvertTo-SetupStatusLabel -Status ([string]$Level.status)
    if ($null -ne $Level.detail -and [string]$Level.detail -ne "") {
        $result += " - $($Level.detail)"
    }
    $issues = @($Level.issues)
    if ($issues.Count -gt 0) {
        $result += " ($($issues -join '; '))"
    }
    return $result
}

function Write-SetupList {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Heading,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Values
    )

    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine("${Heading}:")
    if ($Values.Count -eq 0) {
        [Console]::Out.WriteLine("  none")
        return
    }
    foreach ($value in $Values) {
        [Console]::Out.WriteLine("  - $value")
    }
}

function Write-ModifiedFiles {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Files,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$ManagedChanges
    )

    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine("Modified files:")
    if ($Files.Count -gt 0) {
        foreach ($file in $Files) {
            [Console]::Out.WriteLine("  - $file")
        }
        return
    }
    if ($ManagedChanges.Count -gt 0) {
        [Console]::Out.WriteLine(
            "  none directly verified; client-CLI changes are listed separately"
        )
        return
    }
    [Console]::Out.WriteLine("  none")
}

function Write-ManagedChanges {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Changes
    )

    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine("Client-managed changes:")
    if ($Changes.Count -eq 0) {
        [Console]::Out.WriteLine("  none")
        return
    }
    foreach ($change in $Changes) {
        [Console]::Out.WriteLine(
            "  - $($change.clientName) ($($change.clientId)): $($change.detail)"
        )
        [Console]::Out.WriteLine(
            "    Command: $($change.command)"
        )
        [Console]::Out.WriteLine(
            "    Scope: $($change.scope); config file: $($change.configFileVerification)"
        )
    }
}

function Write-HumanSetupReceipt {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Receipt
    )

    $operationLabel = [string]$Receipt.operation
    $title = switch ([string]$Receipt.overallStatus) {
        "passed" { "ReforgerForge $operationLabel complete" }
        "attention_required" {
            "ReforgerForge $operationLabel requires attention"
        }
        default { "ReforgerForge $operationLabel failed" }
    }
    $settingsResolved =
        [string]$Receipt.verification.effectiveSettings.status -eq "passed"
    $config = if ($null -ne $Receipt.settings.configPath) {
        [string]$Receipt.settings.configPath
    }
    elseif ($settingsResolved) {
        "none (automatic discovery and internal defaults)"
    }
    else {
        "not resolved"
    }
    $project = if ($null -ne $Receipt.settings.projectPath) {
        [string]$Receipt.settings.projectPath
    }
    elseif ($settingsResolved) {
        "none (project-independent mode)"
    }
    else {
        "not resolved"
    }
    $game = if ($null -ne $Receipt.settings.gamePath) {
        [string]$Receipt.settings.gamePath
    }
    elseif ($settingsResolved) { "unavailable" } else { "not resolved" }
    $workbench = if ($null -ne $Receipt.settings.workbenchPath) {
        [string]$Receipt.settings.workbenchPath
    }
    elseif ($settingsResolved) { "unavailable" } else { "not resolved" }
    $addonRoots = @($Receipt.settings.workbenchAddonDirs)
    $startupArguments = @($Receipt.settings.startupArguments)
    $gameCandidates = @($Receipt.settings.steamCandidates.game)
    $workbenchCandidates = @(
        $Receipt.settings.steamCandidates.workbench
    )

    [Console]::Out.WriteLine($title)
    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine("Receipt schema: $($Receipt.schemaVersion)")
    [Console]::Out.WriteLine("Operation:      $($Receipt.operation)")
    [Console]::Out.WriteLine(
        "Overall status: $(ConvertTo-SetupStatusLabel -Status ([string]$Receipt.overallStatus))"
    )
    if ($null -ne $Receipt.failure) {
        [Console]::Out.WriteLine("Failed layer:   $($Receipt.failure.layer)")
        [Console]::Out.WriteLine("Failure:        $($Receipt.failure.message)")
    }
    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine("Server:         $($Receipt.runtime.serverPath)")
    [Console]::Out.WriteLine(
        "Server present: $(if ($Receipt.runtime.serverPresent) { 'yes' } else { 'no' })"
    )
    [Console]::Out.WriteLine(
        "Node:           $($Receipt.runtime.nodePath) ($($Receipt.runtime.nodeVersion))"
    )
    $serverVersion = if ($null -ne $Receipt.runtime.serverVersion) {
        [string]$Receipt.runtime.serverVersion
    }
    else {
        "unavailable"
    }
    [Console]::Out.WriteLine("Version:        $serverVersion")
    [Console]::Out.WriteLine("Transport:      $($Receipt.runtime.transport)")
    [Console]::Out.WriteLine("Config:         $config")
    [Console]::Out.WriteLine("Project:        $project")
    [Console]::Out.WriteLine("Game:           $game")
    [Console]::Out.WriteLine("Tools:          $workbench")
    [Console]::Out.WriteLine(
        "Addon roots:    $(if ($addonRoots.Count -gt 0) { $addonRoots -join ', ' } else { 'none' })"
    )
    [Console]::Out.WriteLine(
        "Startup args:   $(if ($startupArguments.Count -gt 0) { $startupArguments | ConvertTo-Json -Compress } else { 'none' })"
    )
    [Console]::Out.WriteLine(
        "Game candidates:$(if ($gameCandidates.Count -gt 0) { ' ' + ($gameCandidates -join ', ') } else { ' none' })"
    )
    [Console]::Out.WriteLine(
        "Tools candidates:$(if ($workbenchCandidates.Count -gt 0) { ' ' + ($workbenchCandidates -join ', ') } else { ' none' })"
    )
    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine(
        "Steam discovery:    $(Format-SetupLevel -Level $Receipt.verification.steamDiscovery)"
    )
    [Console]::Out.WriteLine(
        "Effective settings: $(Format-SetupLevel -Level $Receipt.verification.effectiveSettings)"
    )
    [Console]::Out.WriteLine(
        "Server handshake:   $(Format-SetupLevel -Level $Receipt.verification.serverHandshake)"
    )
    [Console]::Out.WriteLine(
        "Tool registration:  $(Format-SetupLevel -Level $Receipt.verification.toolRegistration)"
    )
    [Console]::Out.WriteLine(
        "Client registration: $(Format-SetupLevel -Level $Receipt.verification.clientRegistration)"
    )
    [Console]::Out.WriteLine(
        "Workbench NET API:  $(Format-SetupLevel -Level $Receipt.verification.workbenchNetApi)"
    )
    [Console]::Out.WriteLine(
        "Observer capture:   $(Format-SetupLevel -Level $Receipt.verification.observerCapture)"
    )
    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine("Clients:")
    $clients = @($Receipt.clients)
    if ($clients.Count -eq 0) {
        [Console]::Out.WriteLine("  none inspected")
    }
    else {
        foreach ($client in $clients) {
            $clientLine =
                "  - $($client.name): " +
                (ConvertTo-SetupStatusLabel -Status ([string]$client.status))
            if ($null -ne $client.detail -and [string]$client.detail -ne "") {
                $clientLine += " - $($client.detail)"
            }
            [Console]::Out.WriteLine($clientLine)
        }
    }
    $managedChanges = @($Receipt.managedChanges)
    Write-ModifiedFiles `
        -Files @($Receipt.modifiedFiles) `
        -ManagedChanges $managedChanges
    Write-ManagedChanges -Changes $managedChanges
    Write-SetupList -Heading "Backups" -Values @($Receipt.backups)
    Write-SetupList -Heading "Skipped" -Values @($Receipt.skipped)
    Write-SetupList -Heading "Ambiguous" -Values @($Receipt.ambiguous)
    Write-SetupList -Heading "Next actions" -Values @($Receipt.nextActions)
}

function Write-CanonicalSetupReceipt {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Receipt
    )

    if ($Json) {
        [Console]::Out.WriteLine(($Receipt | ConvertTo-Json -Depth 10))
    }
    else {
        Write-HumanSetupReceipt -Receipt $Receipt
    }
}

function Test-CanonicalSetupReceipt {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Receipt,

        [Parameter(Mandatory = $true)]
        [ValidateSet("setup", "doctor")]
        [string]$ExpectedOperation,

        [Parameter(Mandatory = $true)]
        [int]$ExitCode
    )

    $requiredTopLevel = @(
        "schemaVersion",
        "operation",
        "overallStatus",
        "runtime",
        "settings",
        "verification",
        "clients",
        "modifiedFiles",
        "managedChanges",
        "backups",
        "skipped",
        "ambiguous",
        "nextActions"
    )
    foreach ($property in $requiredTopLevel) {
        if ($null -eq $Receipt.PSObject.Properties[$property]) {
            return $false
        }
    }
    foreach (
        $property in @(
            "clients",
            "modifiedFiles",
            "managedChanges",
            "backups",
            "skipped",
            "ambiguous",
            "nextActions"
        )
    ) {
        if (-not ($Receipt.$property -is [System.Array])) {
            return $false
        }
    }
    if (
        $Receipt.schemaVersion -ne 1 -or
        [string]$Receipt.operation -ne $ExpectedOperation -or
        [string]$Receipt.overallStatus -notin @(
            "passed",
            "attention_required",
            "failed"
        )
    ) {
        return $false
    }

    $requiredRuntime = @(
        "serverPath",
        "serverPresent",
        "nodePath",
        "nodeVersion",
        "serverVersion",
        "transport"
    )
    foreach ($property in $requiredRuntime) {
        if ($null -eq $Receipt.runtime.PSObject.Properties[$property]) {
            return $false
        }
    }
    if ([string]$Receipt.runtime.transport -ne "stdio") {
        return $false
    }

    $requiredSettings = @(
        "configPath",
        "projectPath",
        "gamePath",
        "workbenchPath",
        "workbenchAddonDirs",
        "startupArguments",
        "steamCandidates"
    )
    foreach ($property in $requiredSettings) {
        if ($null -eq $Receipt.settings.PSObject.Properties[$property]) {
            return $false
        }
    }
    foreach ($property in @("game", "workbench")) {
        $candidateProperty =
            $Receipt.settings.steamCandidates.PSObject.Properties[$property]
        $candidateValues = $Receipt.settings.steamCandidates.$property
        if (
            $null -eq $candidateProperty -or
            -not ($candidateValues -is [System.Array])
        ) {
            return $false
        }
    }
    foreach ($property in @("workbenchAddonDirs", "startupArguments")) {
        if (-not ($Receipt.settings.$property -is [System.Array])) {
            return $false
        }
    }

    $levelNames = @(
        "steamDiscovery",
        "effectiveSettings",
        "serverHandshake",
        "toolRegistration",
        "clientRegistration",
        "workbenchNetApi",
        "observerCapture"
    )
    foreach ($levelName in $levelNames) {
        $levelProperty =
            $Receipt.verification.PSObject.Properties[$levelName]
        if ($null -eq $levelProperty) {
            return $false
        }
        $level = $levelProperty.Value
        if (
            $null -eq $level.PSObject.Properties["status"] -or
            $null -eq $level.PSObject.Properties["issues"] -or
            -not ($level.issues -is [System.Array]) -or
            [string]$level.status -notin @(
                "passed",
                "attention_required",
                "failed",
                "not_tested",
                "not_run"
            )
        ) {
            return $false
        }
    }

    $expectedExitCode = switch ([string]$Receipt.overallStatus) {
        "passed" { 0 }
        "attention_required" { 2 }
        default { 1 }
    }
    return $ExitCode -eq $expectedExitCode
}

function Stop-CoreSetup {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "platform",
            "package",
            "runtime",
            "dependencies",
            "build",
            "verification",
            "registration",
            "doctor"
        )]
        [string]$Layer,

        [Parameter(Mandatory = $true)]
        [string]$Message,

        [Parameter(Mandatory = $true)]
        [string]$ManualAction
    )

    $receipt = New-CoreSetupFailureReceipt `
        -Layer $Layer `
        -Message $Message `
        -ManualAction $ManualAction
    Write-CanonicalSetupReceipt -Receipt $receipt
    exit 1
}

function Invoke-SetupNativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & $Command @Arguments | ForEach-Object {
        if ($Json) {
            [Console]::Error.WriteLine([string]$_)
        }
        else {
            [Console]::Out.WriteLine([string]$_)
        }
    }
    $commandExitCode = $LASTEXITCODE
    return $commandExitCode
}

function Invoke-CanonicalReceiptCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$FailureLayer,

        [Parameter(Mandatory = $true)]
        [string]$FailureMessage,

        [Parameter(Mandatory = $true)]
        [string]$ManualAction,

        [Parameter(Mandatory = $true)]
        [ValidateSet("setup", "doctor")]
        [string]$ExpectedOperation
    )

    $canonicalArguments = @($Arguments)
    if ($canonicalArguments -notcontains "--json") {
        $canonicalArguments += "--json"
    }
    $stdoutLines = @()
    & $nodeCommand.Source @canonicalArguments | ForEach-Object {
        $stdoutLines += [string]$_
    }
    $commandExitCode = $LASTEXITCODE

    $receiptText = $stdoutLines -join [Environment]::NewLine
    $validReceipt = $false
    $parsedReceipt = $null
    if ($receiptText.Trim().Length -gt 0) {
        try {
            $parsedReceipt = $receiptText | ConvertFrom-Json
            $validReceipt =
                $null -ne $parsedReceipt -and
                (Test-CanonicalSetupReceipt `
                    -Receipt $parsedReceipt `
                    -ExpectedOperation $ExpectedOperation `
                    -ExitCode $commandExitCode)
        }
        catch {
            $validReceipt = $false
        }
    }
    if (-not $validReceipt) {
        Stop-CoreSetup `
            -Layer $FailureLayer `
            -Message $FailureMessage `
            -ManualAction $ManualAction
    }
    Write-CanonicalSetupReceipt -Receipt $parsedReceipt
    return $commandExitCode
}

if ($args.Count -gt 0) {
    Stop-CoreSetup `
        -Layer "package" `
        -Message "setup.ps1 accepts only -Doctor, -CheckWorkbench, and -Json." `
        -ManualAction "Run .\scripts\setup.ps1, optionally with its documented switches."
}

if ($CheckWorkbench -and -not $Doctor) {
    Stop-CoreSetup `
        -Layer "doctor" `
        -Message "-CheckWorkbench is valid only with -Doctor." `
        -ManualAction "Run .\scripts\setup.ps1 -Doctor -CheckWorkbench."
}

Write-SetupMessage -Message "ReforgerForge MCP Setup" -Color Cyan
Write-SetupMessage -Message "=======================" -Color Cyan
Write-SetupMessage -Message ""
Write-SetupMessage -Message "Repo: $Root"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Stop-CoreSetup `
        -Layer "platform" `
        -Message "This setup script supports Windows only." `
        -ManualAction "Install and configure the server manually on this platform."
}

if (-not (Test-Path -LiteralPath (Join-Path $Root "package.json") -PathType Leaf)) {
    Stop-CoreSetup `
        -Layer "package" `
        -Message "Required package asset is missing: package.json" `
        -ManualAction "Restore the missing file from the ReforgerForge package."
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Stop-CoreSetup `
        -Layer "runtime" `
        -Message "Node.js 20 or newer is required." `
        -ManualAction "Install Node.js 20+ from https://nodejs.org, then rerun setup."
}
$script:NodePath = $nodeCommand.Source

$nodeVersion = & $nodeCommand.Source --version 2>$null
if (
    $LASTEXITCODE -ne 0 -or
    -not $nodeVersion -or
    $nodeVersion -notmatch '^v?(?<major>\d+)(?:\.|$)'
) {
    Stop-CoreSetup `
        -Layer "runtime" `
        -Message "Could not determine the installed Node.js version." `
        -ManualAction "Run node --version and repair the Node.js installation."
}
$script:NodeVersion = [string]$nodeVersion

$nodeMajor = [int]$Matches.major
if ($nodeMajor -lt 20) {
    Stop-CoreSetup `
        -Layer "runtime" `
        -Message "Node.js 20 or newer is required (found $nodeVersion)." `
        -ManualAction "Upgrade Node.js, then rerun setup."
}
Write-SetupMessage -Message "Node.js: $nodeVersion"

if ($Doctor) {
    $doctorCliPath = [System.IO.Path]::GetFullPath(
        (Join-Path $Root "dist\setup\doctor-cli.js")
    )
    $doctorOutputs = @(
        $doctorCliPath,
        (Join-Path $Root "dist\setup\doctor.js"),
        (Join-Path $Root "dist\setup\client-registration.js"),
        (Join-Path $Root "dist\setup\server-verification.js"),
        (Join-Path $Root "dist\setup\setup-receipt.js"),
        (Join-Path $Root "dist\workbench\net-api-client.js")
    )
    foreach ($doctorOutput in $doctorOutputs) {
        if (-not (Test-Path -LiteralPath $doctorOutput -PathType Leaf)) {
            $relativeOutput = $doctorOutput.Substring($Root.Length).TrimStart("\")
            Stop-CoreSetup `
                -Layer "doctor" `
                -Message "The compiled Doctor command is incomplete: $relativeOutput is missing." `
                -ManualAction "Build or reinstall ReforgerForge, then rerun Doctor."
        }
    }

    $doctorArguments = @(
        $doctorCliPath,
        "--server",
        $ServerPath
    )
    if ($CheckWorkbench) {
        $doctorArguments += "--check-workbench"
    }
    if ($Json) {
        $doctorArguments += "--json"
    }

    $doctorExitCode = Invoke-CanonicalReceiptCommand `
        -Arguments $doctorArguments `
        -FailureLayer "doctor" `
        -FailureMessage "The compiled Doctor command exited without a valid receipt." `
        -ManualAction "Build or reinstall ReforgerForge, then rerun Doctor." `
        -ExpectedOperation "doctor"
    exit $doctorExitCode
}

$verificationScriptPath = Join-Path $Root "scripts\verify-mcp-server.mjs"
if (-not (Test-Path -LiteralPath $verificationScriptPath -PathType Leaf)) {
    Stop-CoreSetup `
        -Layer "package" `
        -Message "Required package asset is missing: scripts\verify-mcp-server.mjs" `
        -ManualAction "Restore the missing file from the ReforgerForge package."
}

$sourceAssets = @(
    "package-lock.json",
    "tsconfig.build.json",
    "src\index.ts"
)
$presentSourceAssets = @(
    $sourceAssets | Where-Object {
        Test-Path -LiteralPath (Join-Path $Root $_)
    }
)
$isSourceCheckout = $presentSourceAssets.Count -eq $sourceAssets.Count
if (-not $isSourceCheckout -and $presentSourceAssets.Count -gt 0) {
    $missingSourceAssets = @(
        $sourceAssets | Where-Object {
            -not (Test-Path -LiteralPath (Join-Path $Root $_))
        }
    )
    Stop-CoreSetup `
        -Layer "package" `
        -Message "The source checkout is incomplete. Missing: $($missingSourceAssets -join ', ')." `
        -ManualAction "Restore the missing source files or reinstall the published package."
}

if ($isSourceCheckout) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) {
        Stop-CoreSetup `
            -Layer "runtime" `
            -Message "npm.cmd was not found alongside Node.js." `
            -ManualAction "Repair the Node.js/npm installation, then rerun setup."
    }

    Write-SetupMessage -Message ""
    Write-SetupMessage -Message "Installing dependencies..." -Color Yellow
    $installExitCode = 0
    $buildExitCode = $null
    Push-Location $Root
    try {
        $installExitCode = Invoke-SetupNativeCommand `
            -Command $npmCommand.Source `
            -Arguments @("ci")

        if ($installExitCode -eq 0) {
            Write-SetupMessage -Message ""
            Write-SetupMessage -Message "Building..." -Color Yellow
            $buildExitCode = Invoke-SetupNativeCommand `
                -Command $npmCommand.Source `
                -Arguments @("run", "build")
        }
    }
    finally {
        Pop-Location
    }

    if ($installExitCode -ne 0) {
        Stop-CoreSetup `
            -Layer "dependencies" `
            -Message "npm ci failed with exit code $installExitCode." `
            -ManualAction "Run npm.cmd ci in `"$Root`" and resolve the dependency error."
    }

    if ($buildExitCode -ne 0) {
        Stop-CoreSetup `
            -Layer "build" `
            -Message "npm.cmd run build failed with exit code $buildExitCode." `
            -ManualAction "Run npm.cmd run build in `"$Root`" and resolve the build error."
    }
    Write-SetupMessage -Message "Build complete." -Color Green
}
else {
    Write-SetupMessage -Message "Using the package's prebuilt server." -Color Green
}

$registrationCliPath = [System.IO.Path]::GetFullPath(
    (Join-Path $Root "dist\setup\register-clients-cli.js")
)
$setupReceiptCliPath = [System.IO.Path]::GetFullPath(
    (Join-Path $Root "dist\setup\setup-receipt-cli.js")
)
$requiredBuildOutputs = @(
    $ServerPath,
    $registrationCliPath,
    $setupReceiptCliPath,
    (Join-Path $Root "dist\setup\client-registration.js"),
    (Join-Path $Root "dist\setup\server-verification.js"),
    (Join-Path $Root "dist\setup\setup-receipt.js")
)
$buildRecovery = if ($isSourceCheckout) {
    "Run npm.cmd run build in `"$Root`" and inspect the compiler output."
}
else {
    "Reinstall the published ReforgerForge package."
}

foreach ($outputPath in $requiredBuildOutputs) {
    if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
        $relativeOutput = $outputPath.Substring($Root.Length).TrimStart("\")
        Stop-CoreSetup `
            -Layer "build" `
            -Message "The build did not produce $relativeOutput." `
            -ManualAction $buildRecovery
    }
}

$verificationReportPath = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    ("reforger-forge-setup-{0}.json" -f [Guid]::NewGuid().ToString("N"))
$previousReportPath = [Environment]::GetEnvironmentVariable(
    "REFORGER_FORGE_VERIFY_REPORT_PATH",
    "Process"
)
$previousQuiet = [Environment]::GetEnvironmentVariable(
    "REFORGER_FORGE_VERIFY_QUIET",
    "Process"
)
$previousJson = [Environment]::GetEnvironmentVariable(
    "REFORGER_FORGE_VERIFY_JSON",
    "Process"
)

Write-SetupMessage -Message ""
Write-SetupMessage `
    -Message "Verifying config-free MCP startup and tools..." `
    -Color Yellow

try {
    [Environment]::SetEnvironmentVariable(
        "REFORGER_FORGE_VERIFY_REPORT_PATH",
        $verificationReportPath,
        "Process"
    )
    [Environment]::SetEnvironmentVariable(
        "REFORGER_FORGE_VERIFY_QUIET",
        "1",
        "Process"
    )
    [Environment]::SetEnvironmentVariable(
        "REFORGER_FORGE_VERIFY_JSON",
        $null,
        "Process"
    )
    & $nodeCommand.Source $verificationScriptPath
    $verificationExitCode = $LASTEXITCODE
}
finally {
    [Environment]::SetEnvironmentVariable(
        "REFORGER_FORGE_VERIFY_REPORT_PATH",
        $previousReportPath,
        "Process"
    )
    [Environment]::SetEnvironmentVariable(
        "REFORGER_FORGE_VERIFY_QUIET",
        $previousQuiet,
        "Process"
    )
    [Environment]::SetEnvironmentVariable(
        "REFORGER_FORGE_VERIFY_JSON",
        $previousJson,
        "Process"
    )
}

if ($verificationExitCode -ne 0) {
    $receiptArguments = @(
        $setupReceiptCliPath,
        "--server",
        $ServerPath,
        "--verification-report",
        $verificationReportPath
    )
    if ($Json) {
        $receiptArguments += "--json"
    }
    try {
        $null = Invoke-CanonicalReceiptCommand `
            -Arguments $receiptArguments `
            -FailureLayer "verification" `
            -FailureMessage "Verification failed without producing a valid receipt." `
            -ManualAction "Rebuild ReforgerForge and rerun setup." `
            -ExpectedOperation "setup"
    }
    finally {
        Remove-Item -LiteralPath $verificationReportPath `
            -Force `
            -ErrorAction SilentlyContinue
    }
    exit 1
}

Write-SetupMessage -Message ""
Write-SetupMessage -Message "Registering detected MCP clients..." -Color Yellow
$registrationArguments = @(
    $registrationCliPath,
    "--server",
    $ServerPath,
    "--verification-report",
    $verificationReportPath
)
if ($Json) {
    $registrationArguments += "--json"
}
try {
    $registrationExitCode = Invoke-CanonicalReceiptCommand `
        -Arguments $registrationArguments `
        -FailureLayer "registration" `
        -FailureMessage "Client registration exited without a valid receipt." `
        -ManualAction "Rebuild ReforgerForge and rerun setup." `
        -ExpectedOperation "setup"
}
finally {
    Remove-Item -LiteralPath $verificationReportPath `
        -Force `
        -ErrorAction SilentlyContinue
}
exit $registrationExitCode
