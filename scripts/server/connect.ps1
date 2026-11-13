param(
    [Parameter(Mandatory = $true)]
    [string]$SshTarget,
    [string]$IdentityFile,
    [ValidateRange(1024, 65535)]
    [int]$LocalPort = 48886,
    [ValidateRange(1024, 65535)]
    [int]$RemotePort = 38886
)

$ErrorActionPreference = 'Stop'
if ($SshTarget.StartsWith('-') -or $SshTarget -match '\s') {
    throw 'Use an SSH profile name or user@host without spaces.'
}
$bbSshArgs = @('-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3')
if ($IdentityFile) {
    $bbKeyPath = (Resolve-Path -LiteralPath $IdentityFile).Path
    $bbSshArgs += @('-i', $bbKeyPath)
}
$bbSshArgs += @('-L', "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}", $SshTarget)
Write-Host "Keep this terminal open. Connect bb Desktop to http://127.0.0.1:$LocalPort in Settings -> Execution mode -> Add server."
& ssh @bbSshArgs
exit $LASTEXITCODE
