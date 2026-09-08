$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing
Import-Module (Join-Path $PSScriptRoot 'TrayCore.psm1') -Force

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$settingsRoot = Join-Path $env:TEMP ("local-codex-bridge-settings-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $settingsRoot | Out-Null
$settingsPath = Join-Path $settingsRoot 'local-settings.json'
$settingsJson = @'
{
  "readyUrl": "http://127.0.0.1:19001/readyz",
  "tunnelProfile": "settings-profile",
  "tunnelExecutable": "C:\\Example\\settings\\tunnel-client.exe",
  "projectionPath": "C:\\Example\\settings\\projection.json",
  "checkpointDirectory": "C:\\Example\\settings\\checkpoints"
}
'@
Set-Content -LiteralPath $settingsPath -Value $settingsJson -Encoding UTF8
try {
    $legacySettings = Resolve-LocalCodexBridgeSettings -SettingsPath $settingsPath -Environment @{
        LOCALAPPDATA = 'C:\Example\AppData\Local'
        LUMEN_CODEX_V2_READY_URL = 'http://127.0.0.1:19002/readyz'
        LUMEN_CODEX_V2_TUNNEL_PROFILE = 'legacy-profile'
        LUMEN_CODEX_V2_TUNNEL_EXE = 'C:\Example\legacy\tunnel-client.exe'
        LUMEN_CODEX_V2_UX_PROJECTION = 'C:\Example\legacy\projection.json'
        LUMEN_CODEX_V2_CHECKPOINT_DIR = 'C:\Example\legacy\checkpoints'
    }
    Assert-True ($legacySettings.ReadyUrl -ceq 'http://127.0.0.1:19002/readyz') 'Legacy ready URL must be supported.'
    Assert-True ($legacySettings.ProfileName -ceq 'legacy-profile') 'Legacy Tunnel profile must be supported.'
    Assert-True ($legacySettings.TunnelExecutable -ceq 'C:\Example\legacy\tunnel-client.exe') 'Legacy Tunnel executable must be supported.'
    Assert-True ($legacySettings.ProjectionPath -ceq 'C:\Example\legacy\projection.json') 'Legacy projection path must be supported.'
    Assert-True ($legacySettings.CheckpointDirectory -ceq 'C:\Example\legacy\checkpoints') 'Legacy checkpoint path must be supported.'

    $genericSettings = Resolve-LocalCodexBridgeSettings -SettingsPath $settingsPath -Environment @{
        LOCALAPPDATA = 'C:\Example\AppData\Local'
        LOCAL_CODEX_BRIDGE_READY_URL = 'http://127.0.0.1:19003/readyz'
        LOCAL_CODEX_BRIDGE_TUNNEL_PROFILE = 'generic-profile'
        LOCAL_CODEX_BRIDGE_TUNNEL_EXE = 'C:\Example\generic\tunnel-client.exe'
        LOCAL_CODEX_BRIDGE_PROJECTION_PATH = 'C:\Example\generic\projection.json'
        LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR = 'C:\Example\generic\checkpoints'
        LUMEN_CODEX_V2_READY_URL = 'http://127.0.0.1:19004/readyz'
        LUMEN_CODEX_V2_TUNNEL_PROFILE = 'ignored-legacy-profile'
    }
    Assert-True ($genericSettings.ReadyUrl -ceq 'http://127.0.0.1:19003/readyz') 'Generic ready URL must override legacy settings.'
    Assert-True ($genericSettings.ProfileName -ceq 'generic-profile') 'Generic Tunnel profile must override legacy settings.'
    Assert-True ($genericSettings.TunnelExecutable -ceq 'C:\Example\generic\tunnel-client.exe') 'Generic Tunnel executable must override legacy settings.'
    Assert-True ($genericSettings.ProjectionPath -ceq 'C:\Example\generic\projection.json') 'Generic projection path must override legacy settings.'
    Assert-True ($genericSettings.CheckpointDirectory -ceq 'C:\Example\generic\checkpoints') 'Generic checkpoint path must override legacy settings.'

    $settingsOnly = Resolve-LocalCodexBridgeSettings -SettingsPath $settingsPath -Environment @{
        LOCALAPPDATA = 'C:\Example\AppData\Local'
    }
    Assert-True ($settingsOnly.ProfileName -ceq 'settings-profile') 'Local settings must be used when env is absent.'
    Assert-True ($settingsOnly.ProjectionPath -ceq 'C:\Example\settings\projection.json') 'Local projection settings must be used when env is absent.'

    $fallback = Resolve-LocalCodexBridgeSettings -SettingsPath (Join-Path $settingsRoot 'missing.json') -Environment @{
        LOCALAPPDATA = 'C:\Example\AppData\Local'
    }
    Assert-True ($fallback.ProjectionPath -ceq 'C:\Example\AppData\Local\LocalCodexBridge\ux-projection.json') 'Canonical projection fallback must be deterministic.'
} finally {
    Remove-Item -LiteralPath $settingsRoot -Recurse -Force
}

foreach ($state in @('stopped', 'starting', 'ready', 'attention', 'error')) {
    Assert-True ((Resolve-TrayIconState $state 0) -ceq $state) "Zero waiting count must preserve icon state: $state"
}
Assert-True ((Resolve-TrayIconState 'ready' 1) -ceq 'attention') 'Waiting work must override a ready icon.'
Assert-True ((Resolve-TrayIconState 'starting' 2) -ceq 'attention') 'Waiting work must override a starting icon.'
Assert-True ((Resolve-TrayIconState 'error' 1) -ceq 'error') 'An error icon must take priority over waiting work.'
Assert-True ((Resolve-NotReadyBaseIconState 'stopped' $false) -ceq 'stopped') 'Unknown non-ready state must remain stopped.'
Assert-True ((Resolve-NotReadyBaseIconState 'ready' $false) -ceq 'stopped') 'A lost external ready endpoint must fall back to stopped/unknown.'
Assert-True ((Resolve-NotReadyBaseIconState 'starting' $false) -ceq 'starting') 'An observed external non-ready Tunnel must remain starting.'
Assert-True ((Resolve-NotReadyBaseIconState 'attention' $false) -ceq 'attention') 'Ownership-proof attention must survive non-ready polling.'
Assert-True ((Resolve-NotReadyBaseIconState 'stopped' $true) -ceq 'starting') 'An owned non-ready Tunnel must show starting.'

$iconDirectory = Join-Path $PSScriptRoot 'icons'
foreach ($state in @('stopped', 'starting', 'ready', 'attention', 'error')) {
    $iconPath = Join-Path $iconDirectory "$state.ico"
    Assert-True (Test-Path -LiteralPath $iconPath -PathType Leaf) "Tray icon must exist: $state"
    $bytes = [IO.File]::ReadAllBytes($iconPath)
    Assert-True ($bytes.Length -gt 22) "Tray icon must not be empty: $state"
    Assert-True (
        $bytes[0] -eq 0 -and $bytes[1] -eq 0 -and $bytes[2] -eq 1 -and $bytes[3] -eq 0
    ) "Tray icon must have an ICO header: $state"
    $imageCount = [BitConverter]::ToUInt16($bytes, 4)
    Assert-True ($imageCount -ge 4) "Tray icon must include 16/20/24/32 pixel images: $state"
    for ($imageIndex = 0; $imageIndex -lt $imageCount; $imageIndex += 1) {
        $entryOffset = 6 + (16 * $imageIndex)
        $imageOffset = [int][BitConverter]::ToUInt32($bytes, $entryOffset + 12)
        Assert-True ($imageOffset + 8 -le $bytes.Length) "Tray icon image offset must be valid: $state"
        Assert-True ([BitConverter]::ToUInt32($bytes, $imageOffset) -eq 40) "Tray icon entries must use DIB data: $state"
        $isPng =
            $bytes[$imageOffset] -eq 0x89 -and
            $bytes[$imageOffset + 1] -eq 0x50 -and
            $bytes[$imageOffset + 2] -eq 0x4e -and
            $bytes[$imageOffset + 3] -eq 0x47
        Assert-True (-not $isPng) "Tray icon entries must not use PNG payloads: $state"
    }
    $icon = New-Object Drawing.Icon -ArgumentList ([IO.Path]::GetFullPath($iconPath))
    try {
        Assert-True ($icon.Width -gt 0 -and $icon.Height -gt 0) "Tray icon must load through System.Drawing: $state"
    } finally {
        $icon.Dispose()
    }
}

$trayScriptPath = Join-Path $PSScriptRoot 'LocalCodexBridgeTray.ps1'
$legacyTrayScriptPath = Join-Path $PSScriptRoot 'LumenCodexControlV2Tray.ps1'
$dailyLauncherPath = Join-Path $PSScriptRoot 'LocalCodexBridgeTray.vbs'
$compatibilityLauncherPath = Join-Path $PSScriptRoot 'LocalCodexBridgeTray.cmd'
$debugLauncherPath = Join-Path $PSScriptRoot 'LocalCodexBridgeTray.Debug.cmd'
foreach ($scriptPath in @($trayScriptPath, $legacyTrayScriptPath)) {
    $tokens = $null
    $parseErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
    Assert-True ($parseErrors.Count -eq 0) "PowerShell Tray script must parse: $scriptPath"
}
$canonicalTraySource = Get-Content -LiteralPath $trayScriptPath -Raw -Encoding UTF8
$legacyTraySource = Get-Content -LiteralPath $legacyTrayScriptPath -Raw -Encoding UTF8
$traySource = $canonicalTraySource
Assert-True ($canonicalTraySource -notmatch 'LumenCodexControlV2Tray\.(?:ps1|vbs|cmd)') 'Canonical Tray implementation must not depend on legacy launcher files.'
Assert-True ($canonicalTraySource -match 'TrayCore\.psm1') 'Canonical Tray implementation must use the shared canonical Tray core.'
Assert-True ($canonicalTraySource -match '\$startInfo\.EnvironmentVariables\[''LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR''\]\s*=\s*\$checkpointDirectoryPath') 'Canonical Tray must pass the resolved checkpoint directory through the canonical environment.'
Assert-True ($canonicalTraySource -match '\$startInfo\.EnvironmentVariables\[''LUMEN_CODEX_V2_CHECKPOINT_DIR''\]\s*=\s*\$checkpointDirectoryPath') 'Canonical Tray must pass the resolved checkpoint directory through the legacy environment alias.'
Assert-True ($legacyTraySource -match 'LocalCodexBridgeTray\.ps1') 'Legacy PowerShell Tray entry must forward to the canonical implementation.'
Assert-True ($legacyTraySource -notmatch 'Add-Type|Resolve-LocalCodexBridgeSettings|Windows\.Forms') 'Legacy PowerShell Tray entry must remain a thin shim.'
Assert-True ($traySource -notmatch '\$notifyIcon\.Icon\s*=\s*\[Drawing\.SystemIcons\]::Application') 'Tray must not assign the generic Application icon directly.'
foreach ($state in @('stopped', 'starting', 'ready', 'attention', 'error')) {
    Assert-True ($traySource.Contains("$state.ico")) "Tray must reference its state icon: $state"
}
Assert-True (Test-Path -LiteralPath $dailyLauncherPath -PathType Leaf) 'Daily WScript launcher must exist.'
$dailyLauncherSource = Get-Content -LiteralPath $dailyLauncherPath -Raw -Encoding ASCII
Assert-True ($dailyLauncherSource -match '(?i)CreateObject\("WScript\.Shell"\)') 'Daily launcher must use the windowless WScript host.'
Assert-True ($dailyLauncherSource -match '(?i)System32\\WindowsPowerShell\\v1\.0\\powershell\.exe') 'Daily launcher must use the built-in Windows PowerShell host.'
Assert-True ($dailyLauncherSource -match '(?i)-WindowStyle\s+Hidden') 'Daily launcher must hide its PowerShell child.'
Assert-True ($dailyLauncherSource -match '(?i)shell\.Run\s+command\s*,\s*0\s*,\s*False') 'Daily launcher must request a hidden non-blocking window.'
Assert-True ($dailyLauncherSource -notmatch '(?i)cmd\.exe|\.cmd') 'Daily launcher must not traverse a console batch host.'
$compatibilityLauncherSource = Get-Content -LiteralPath $compatibilityLauncherPath -Raw -Encoding ASCII
Assert-True ($compatibilityLauncherSource -notmatch '(?i)(?:^|\s)/min(?:\s|$)') 'Compatibility launcher must not retain the old minimized mode.'
Assert-True ($compatibilityLauncherSource -match '(?i)-WindowStyle\s+Hidden') 'Normal canonical launcher must remain hidden.'
Assert-True ($compatibilityLauncherSource -match '(?i)LocalCodexBridgeTray\.ps1') 'Normal canonical launcher must invoke the canonical implementation.'
Assert-True ($compatibilityLauncherSource -notmatch '(?i)LocalCodexBridgeTray\.Debug\.cmd') 'Normal canonical launcher must not invoke Debug.'
Assert-True (Test-Path -LiteralPath $debugLauncherPath -PathType Leaf) 'Debug launcher must exist.'
$debugLauncherSource = Get-Content -LiteralPath $debugLauncherPath -Raw -Encoding ASCII
Assert-True ($debugLauncherSource -match '(?i)-NoExit') 'Debug launcher must keep its console available.'
Assert-True ($debugLauncherSource -notmatch '(?i)-WindowStyle\s+Hidden') 'Debug launcher must keep its console visible.'
$legacyDailyLauncherSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'LumenCodexControlV2Tray.vbs') -Raw -Encoding ASCII
$legacyCompatibilityLauncherSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'LumenCodexControlV2Tray.cmd') -Raw -Encoding ASCII
$legacyDebugLauncherSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'LumenCodexControlV2Tray.Debug.cmd') -Raw -Encoding ASCII
Assert-True ($legacyDailyLauncherSource -match '(?i)LocalCodexBridgeTray\.vbs') 'Legacy WScript launcher must forward to the canonical WScript launcher.'
Assert-True ($legacyDailyLauncherSource -notmatch '(?i)LumenCodexControlV2Tray\.ps1') 'Legacy WScript launcher must not target a legacy implementation.'
Assert-True ($legacyCompatibilityLauncherSource -match '(?i)LocalCodexBridgeTray\.cmd') 'Legacy normal launcher must forward to the canonical normal launcher.'
Assert-True ($legacyDebugLauncherSource -match '(?i)LocalCodexBridgeTray\.Debug\.cmd') 'Legacy Debug launcher must forward to the canonical Debug launcher.'
foreach ($legacyPath in @(
    (Join-Path $PSScriptRoot 'LumenCodexControlV2Tray.ps1'),
    (Join-Path $PSScriptRoot 'LumenCodexControlV2Tray.vbs'),
    (Join-Path $PSScriptRoot 'LumenCodexControlV2Tray.cmd'),
    (Join-Path $PSScriptRoot 'LumenCodexControlV2Tray.Debug.cmd')
)) {
    Assert-True (Test-Path -LiteralPath $legacyPath -PathType Leaf) "Legacy Tray entry must remain available: $legacyPath"
}

$cursor = New-ProjectionCursor
$oldProjection = [pscustomobject]@{
    generation = [pscustomobject]@{ id = 'generation-a' }
    sequence = 2
    signals = @(
        [pscustomobject]@{ sequence = 1; kind = 'waiting_approval' },
        [pscustomobject]@{ sequence = 2; kind = 'terminal' }
    )
}
Assert-True (@(Select-NewProjectionSignals $cursor $oldProjection).Count -eq 0) 'Startup must baseline old signals.'
Assert-True (@(Select-NewProjectionSignals $cursor $oldProjection).Count -eq 0) 'Repeated reads must not duplicate signals.'

$laterProjection = [pscustomobject]@{
    generation = [pscustomobject]@{ id = 'generation-a' }
    sequence = 3
    signals = @($oldProjection.signals + [pscustomobject]@{ sequence = 3; kind = 'waiting_user_input' })
}
$newSignals = @(Select-NewProjectionSignals $cursor $laterProjection)
Assert-True ($newSignals.Count -eq 1 -and $newSignals[0].sequence -eq 3) 'A later signal must notify once.'
Assert-True (@(Select-NewProjectionSignals $cursor $laterProjection).Count -eq 0) 'A consumed signal must dedupe.'

$newGeneration = [pscustomobject]@{
    generation = [pscustomobject]@{ id = 'generation-b' }
    sequence = 8
    signals = @([pscustomobject]@{ sequence = 8; kind = 'terminal' })
}
Assert-True (@(Select-NewProjectionSignals $cursor $newGeneration).Count -eq 0) 'A new generation must baseline its existing signals.'

$terminalNoticeCases = @(
    [pscustomobject]@{
        Status = 'completed'
        Title = 'Codex turn completed'
        Text = 'A Codex turn completed successfully.'
    },
    [pscustomobject]@{
        Status = 'interrupted'
        Title = 'Codex turn interrupted'
        Text = 'A Codex turn was interrupted or cancelled.'
    },
    [pscustomobject]@{
        Status = 'failed'
        Title = 'Codex turn failed'
        Text = 'A Codex turn failed or ended abnormally (status: failed).'
    }
)
foreach ($case in $terminalNoticeCases) {
    $notice = Resolve-TerminalNotice $case.Status
    Assert-True ($notice.Title -ceq $case.Title) "Terminal notice title must match status: $($case.Status)"
    Assert-True ($notice.Text -ceq $case.Text) "Terminal notice text must match status: $($case.Status)"
}
Assert-True ($traySource -match 'Resolve-TerminalNotice\s+\(\[string\]\$signal\.status\)') 'Tray terminal notifications must use the status mapping.'

$fakeProcess = [pscustomobject]@{ Id = 4242; HasExited = $false }
$ownership = [pscustomobject]@{
    Process = $fakeProcess
    ProcessId = 4242
    ExecutablePath = 'C:\Example\tunnel-client.exe'
    StartTimeUtcTicks = 123456789L
    LaunchCommandLine = '"C:\Example\tunnel-client.exe" run --profile example-profile --pid.file "C:\Example\run\unique.pid"'
    ProfileName = 'example-profile'
    PidFilePath = 'C:\Example\run\unique.pid'
}
$observation = [pscustomobject]@{
    ProcessId = 4242
    ExecutablePath = 'C:\Example\tunnel-client.exe'
    StartTimeUtcTicks = 123456789L
    CommandLine = $ownership.LaunchCommandLine
    ProfileName = 'example-profile'
    PidFilePath = 'C:\Example\run\unique.pid'
}
Assert-True (Test-TunnelOwnershipEvidence $ownership $observation 4242) 'Matching strong ownership evidence must pass.'
foreach ($property in @('ProcessId', 'ExecutablePath', 'StartTimeUtcTicks', 'CommandLine', 'ProfileName', 'PidFilePath')) {
    $changed = $observation.PSObject.Copy()
    switch ($property) {
        'ProcessId' { $changed.ProcessId = 4243 }
        'ExecutablePath' { $changed.ExecutablePath = 'C:\Other\tunnel-client.exe' }
        'StartTimeUtcTicks' { $changed.StartTimeUtcTicks = 987654321L }
        'CommandLine' { $changed.CommandLine = $changed.CommandLine + ' --different' }
        'ProfileName' { $changed.ProfileName = 'different-profile' }
        'PidFilePath' { $changed.PidFilePath = 'C:\Example\run\different.pid' }
    }
    Assert-True (-not (Test-TunnelOwnershipEvidence $ownership $changed 4242)) "Ownership mismatch must fail: $property"
}
Assert-True (-not (Test-TunnelOwnershipEvidence $ownership $observation 9999)) 'PID-file mismatch must fail.'

Write-Output 'TRAY_CORE_TESTS_OK'
