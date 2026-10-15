param([ValidateRange(30,3600)][int]$TimeoutSeconds = 180, [string]$ProjectRoot = (Split-Path $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$user = 'habby-ci'
$otherUser = 'habby-reader-ci'
$secure = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
$testRoot = Join-Path $env:PUBLIC 'habby-ci-tests'
if (Test-Path -LiteralPath $testRoot) { throw "Test directory already exists: $testRoot" }
$manifestPath = Join-Path $testRoot 'probe.json'
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$powershell = (Get-Command powershell.exe -CommandType Application | Select-Object -First 1).Source
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$createdUser = $false
$createdOtherUser = $false
$projectReadGranted = $false
function Invoke-StandardUser($account, $executable, $arguments, $logPrefix) {
  $credential = [pscredential]::new("$env:COMPUTERNAME\$account", $secure)
  $stdout = Join-Path $testRoot "$logPrefix-stdout.log"
  $stderr = Join-Path $testRoot "$logPrefix-stderr.log"
  $test = Start-Process -FilePath $executable -WorkingDirectory $projectRoot -Credential $credential -LoadUserProfile -WindowStyle Hidden -PassThru `
    -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $processHandle = $test.Handle # Preserve ExitCode for redirected Start-Process children.
  if (-not $test.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $test.Id -Force -ErrorAction SilentlyContinue
    throw "Native Windows test exceeded $TimeoutSeconds seconds."
  }
  Get-Content -Encoding UTF8 $stdout,$stderr
  if ($test.ExitCode -ne 0) { throw "Native Windows test exited $($test.ExitCode)." }
}
try {
  New-LocalUser -Name $user -Password $secure | Out-Null
  $createdUser = $true
  New-LocalUser -Name $otherUser -Password $secure | Out-Null
  $createdOtherUser = $true
  & icacls.exe $testRoot /grant "$($env:COMPUTERNAME)\${user}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant standard user fixture access.' }
  & icacls.exe $testRoot /grant "$($env:COMPUTERNAME)\${otherUser}:(OI)(CI)RX" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant second user fixture read access.' }
  & icacls.exe $projectRoot /grant "$($env:COMPUTERNAME)\${user}:(OI)(CI)RX" /Q | Out-Null
  $projectReadGranted = $true
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant standard user code/dependency read access.' }
  # LoadUserProfile creates the user's environment; set test variables in that child.
  $owner = @'
param([string]$NodePath, [string]$ProjectRoot)
$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
$env:TEMP=$PSScriptRoot
$env:TMP=$PSScriptRoot
$env:HABBY_REQUIRE_STANDARD_USER='1'
$env:HABBY_NATIVE_TEST_ROOT=$PSScriptRoot
$env:HABBY_ACL_PROBE_MANIFEST=Join-Path $PSScriptRoot 'probe.json'
$source = Join-Path $ProjectRoot 'tests/windows-state.test.ts'
if (Test-Path -LiteralPath $source) {
  & $NodePath --import (Join-Path $ProjectRoot 'node_modules/tsx/dist/loader.mjs') --test $source
} else {
  & $NodePath --test (Join-Path $ProjectRoot 'tests/windows-state.test.js')
}
exit $LASTEXITCODE
'@
  $ownerPath = Join-Path $testRoot 'owner.ps1'
  Set-Content -LiteralPath $ownerPath -Value $owner -Encoding UTF8
  Invoke-StandardUser $user $powershell "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ownerPath`" -NodePath `"$node`" -ProjectRoot `"$projectRoot`"" 'owner'
  $probe = @'
$ErrorActionPreference='Stop'
$principal=New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
if($principal.IsInRole([System.Security.Principal.WindowsBuiltinRole]::Administrator)) { throw 'Reader must be a standard user.' }
$manifest=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'probe.json') | ConvertFrom-Json
$files=@($manifest.files)
if($files.Count -ne 7) { throw 'Expected seven state/control file probes.' }
foreach($file in $files) {
  if(-not ($file -is [string]) -or [string]::IsNullOrWhiteSpace($file)) { throw 'Missing state/control file probe path.' }
  try { [IO.File]::ReadAllText($file) | Out-Null; throw 'Second user read private state.' }
  catch { if(-not ($_.Exception.GetBaseException() -is [UnauthorizedAccessException])) { throw } }
}
Write-Output 'PASS: second standard user cannot read sensitive state or control files by full path.'
exit 0
'@
  # Credentialed process creation limits the command line to 1024 characters.
  $probePath = Join-Path $testRoot 'reader.ps1'
  Set-Content -LiteralPath $probePath -Value $probe -Encoding UTF8
  Invoke-StandardUser $otherUser $powershell "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$probePath`"" 'reader'
} finally {
  try {
    if (Test-Path -LiteralPath $manifestPath) {
      $cleanup = @'
$ErrorActionPreference='Stop'
$manifest=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'probe.json') | ConvertFrom-Json
if([string]::IsNullOrWhiteSpace($manifest.cleanupDir)) { throw 'Missing fixture cleanup directory.' }
$directory=[IO.Path]::GetFullPath($manifest.cleanupDir)
if([IO.Path]::GetDirectoryName($directory) -ne $PSScriptRoot -or [IO.Path]::GetFileName($directory) -notlike 'tabby-state-acl-*') {
  throw 'Fixture cleanup directory is outside this test root.'
}
Remove-Item -LiteralPath $directory -Recurse -Force
if(Test-Path -LiteralPath $directory) { throw 'Fixture cleanup incomplete.' }
'@
      $cleanupPath = Join-Path $testRoot 'cleanup.ps1'
      Set-Content -LiteralPath $cleanupPath -Value $cleanup -Encoding UTF8
      Invoke-StandardUser $user $powershell "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$cleanupPath`"" 'cleanup'
    }
  } finally {
    if ($projectReadGranted) {
      & icacls.exe $projectRoot /remove:g "$($env:COMPUTERNAME)\${user}" /Q | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Warning 'Could not remove all temporary code/dependency read grants.' }
    }
    if ($createdOtherUser) { Remove-LocalUser -Name $otherUser -ErrorAction SilentlyContinue }
    if ($createdUser) { Remove-LocalUser -Name $user }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
