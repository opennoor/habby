$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$user = 'tabby-hub-ci'
$otherUser = 'tabby-hub-reader-ci'
$secure = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
$testRoot = Join-Path $env:PUBLIC 'tabby-hub-ci-tests'
$manifestPath = Join-Path $testRoot 'probe.json'
$projectRoot = Split-Path $PSScriptRoot
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$powershell = (Get-Command powershell.exe -CommandType Application | Select-Object -First 1).Source
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
New-LocalUser -Name $user -Password $secure | Out-Null
function Invoke-StandardUser($account, $executable, $arguments, $logPrefix) {
  $credential = [pscredential]::new("$env:COMPUTERNAME\$account", $secure)
  $stdout = Join-Path $testRoot "$logPrefix-stdout.log"
  $stderr = Join-Path $testRoot "$logPrefix-stderr.log"
  $test = Start-Process -FilePath $executable -WorkingDirectory $projectRoot -Credential $credential -LoadUserProfile -PassThru `
    -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $processHandle = $test.Handle # Preserve ExitCode for redirected Start-Process children.
  if (-not $test.WaitForExit(180000)) {
    Stop-Process -Id $test.Id -Force -ErrorAction SilentlyContinue
    throw 'Native Windows test exceeded three minutes.'
  }
  Get-Content $stdout,$stderr
  if ($test.ExitCode -ne 0) { throw "Native Windows test exited $($test.ExitCode)." }
}
try {
  New-LocalUser -Name $otherUser -Password $secure | Out-Null
  & icacls.exe $testRoot /grant "$($env:COMPUTERNAME)\${user}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant standard user fixture access.' }
  & icacls.exe $testRoot /grant "$($env:COMPUTERNAME)\${otherUser}:(OI)(CI)RX" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant second user fixture read access.' }
  & icacls.exe $projectRoot /grant "$($env:COMPUTERNAME)\${user}:(OI)(CI)RX" /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant standard user code/dependency read access.' }
  $env:TEMP = $testRoot
  $env:TMP = $testRoot
  $env:TABBY_HUB_REQUIRE_STANDARD_USER = '1'
  $env:TABBY_HUB_NATIVE_TEST_ROOT = $testRoot
  $env:TABBY_HUB_ACL_PROBE_MANIFEST = $manifestPath
  Invoke-StandardUser $user $node '--import tsx --test tests/windows-state.test.ts' 'owner'
  $probe = @'
$ErrorActionPreference='Stop'
$principal=New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
if($principal.IsInRole([System.Security.Principal.WindowsBuiltinRole]::Administrator)) { throw 'Reader must be a standard user.' }
$manifest=Get-Content -Raw -LiteralPath $env:TABBY_HUB_ACL_PROBE_MANIFEST | ConvertFrom-Json
foreach($file in @($manifest.file,$manifest.database)) {
  try { [IO.File]::ReadAllText($file) | Out-Null; throw 'Second user read private state.' }
  catch { if(-not ($_.Exception.GetBaseException() -is [UnauthorizedAccessException])) { throw } }
}
Write-Output 'PASS: second standard user cannot read secrets or authentication database by full path.'
exit 0
'@
  # Credentialed process creation limits the command line to 1024 characters.
  $probePath = Join-Path $testRoot 'reader.ps1'
  Set-Content -LiteralPath $probePath -Value $probe -Encoding UTF8
  Invoke-StandardUser $otherUser $powershell "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$probePath`"" 'reader'
} finally {
  try {
    if (Test-Path -LiteralPath $manifestPath) {
      $cleanup = '$ErrorActionPreference="Stop"; $manifest=Get-Content -Raw -LiteralPath $env:TABBY_HUB_ACL_PROBE_MANIFEST | ConvertFrom-Json; Remove-Item -LiteralPath $manifest.stateDir -Recurse -Force'
      $cleanupPath = Join-Path $testRoot 'cleanup.ps1'
      Set-Content -LiteralPath $cleanupPath -Value $cleanup -Encoding UTF8
      Invoke-StandardUser $user $powershell "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$cleanupPath`"" 'cleanup'
    }
  } finally {
    Remove-LocalUser -Name $otherUser -ErrorAction SilentlyContinue
    Remove-LocalUser -Name $user
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
