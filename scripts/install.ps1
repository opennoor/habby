param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9A-Za-z._-]+$')][string]$Version, [string]$ArchiveDir, [string]$PluginDir)
$ErrorActionPreference = 'Stop'
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$arch = switch ($architecture) {
  'X64' { 'x64' }
  'Arm64' { 'arm64' }
  default { throw "Unsupported Windows architecture: $_" }
}
$name = "habby-$Version-win-$arch"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ($ArchiveDir) { Copy-Item (Join-Path $ArchiveDir "$name.tar.gz") $tmp; Copy-Item (Join-Path $ArchiveDir SHA256SUMS) $tmp }
  elseif (Get-Command gh -ErrorAction SilentlyContinue) {
    & gh release download "v$Version" --repo Sojaner/habby --pattern "$name.tar.gz" --pattern SHA256SUMS --dir $tmp
    if ($LASTEXITCODE -ne 0) { throw 'Release download failed.' }
  } else {
    $base = "https://github.com/Sojaner/habby/releases/download/v$Version"
    Invoke-WebRequest "$base/$name.tar.gz" -OutFile (Join-Path $tmp "$name.tar.gz")
    Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp SHA256SUMS)
  }
  $line = Get-Content (Join-Path $tmp SHA256SUMS) | Where-Object { $_ -match ('^[a-f0-9]{64}  ' + [Regex]::Escape("$name.tar.gz") + '$') }
  if (@($line).Count -ne 1) { throw 'Missing or ambiguous release checksum.' }
  $expected = $line.Substring(0,64)
  if ((Get-FileHash (Join-Path $tmp "$name.tar.gz") -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Release checksum mismatch.' }
  & tar.exe -xzf (Join-Path $tmp "$name.tar.gz") -C $tmp
  if ($LASTEXITCODE -ne 0) { throw 'Archive extraction failed; Windows 10/11 tar.exe is required.' }
  $destination = Join-Path $env:LOCALAPPDATA "Habby\versions\$Version-win-$arch"
  if (Test-Path $destination) { throw "Version already exists: $destination (remove explicitly to reinstall)." }
  New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
  Move-Item (Join-Path $tmp $name) $destination
  $launcher = Join-Path $destination 'bin\habby.cmd'
  if ($PluginDir) { & $launcher install --plugin-dir $PluginDir } else { & $launcher install }
  if ($LASTEXITCODE -ne 0) { throw 'Hub installation failed; inspect the service error and retained version directory.' }
  $bin = Join-Path $env:LOCALAPPDATA 'Habby\bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  [IO.File]::WriteAllText((Join-Path $bin 'habby.cmd'), "@echo off`r`n`"$launcher`" %*`r`n")
  Write-Output "Installed $Version. Add $bin to your user PATH and restart Tabby windows."
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
