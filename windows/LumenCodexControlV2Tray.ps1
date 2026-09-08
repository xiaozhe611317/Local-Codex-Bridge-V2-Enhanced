param(
    [string]$ReadyUrl,
    [string]$ProfileName,
    [string]$TunnelExecutable,
    [string]$ProjectionPath,
    [string]$CheckpointDirectory
)

$canonicalImplementation = Join-Path $PSScriptRoot 'LocalCodexBridgeTray.ps1'
& $canonicalImplementation @PSBoundParameters
if ($null -ne $LASTEXITCODE) {
    exit $LASTEXITCODE
}
