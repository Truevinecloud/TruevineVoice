param(
  [Parameter(Mandatory=$true)][ValidateSet('write','read','self-test')][string]$Action,
  [Parameter(Mandatory=$true)][string]$OperationId,
  [string]$RepositoryRoot
)
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  if ($OperationId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { throw 'Invalid operation' }
  Add-Type -AssemblyName System.Security
  if ($Action -eq 'self-test') {
    # Synthetic, memory-only offline fixture; no credential or file is created.
    $sample = [Text.Encoding]::UTF8.GetBytes('Truevine synthetic DPAPI roundtrip fixture')
    $protected = [Security.Cryptography.ProtectedData]::Protect($sample, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $restored = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ([Convert]::ToBase64String($sample) -ne [Convert]::ToBase64String($restored)) { throw 'Roundtrip failed' }
    [Console]::Out.WriteLine('Windows DPAPI synthetic memory roundtrip passed; no files or database touched.')
    exit 0
  }
  if (-not [Console]::IsOutputRedirected -or ($Action -eq 'write' -and -not [Console]::IsInputRedirected)) { throw 'Private pipe required' }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  if (-not [IO.Path]::IsPathRooted($local)) { throw 'Local app data unavailable' }
  $directory = [IO.Path]::Combine($local, 'TruevineVoice-QA-Recovery')
  if (-not [IO.Path]::IsPathRooted($RepositoryRoot)) { throw 'Repository guard required' }
  $repository = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\') + '\'
  if (($directory + '\').StartsWith($repository, [StringComparison]::OrdinalIgnoreCase)) { throw 'Repository storage refused' }
  # Refuse junctions/symlinks on every existing ancestor, including LocalAppData.
  $ancestor = $directory
  while ($ancestor) {
    if ([IO.Directory]::Exists($ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse point refused' }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
  if (-not [IO.Directory]::Exists($directory)) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    [IO.Directory]::CreateDirectory($directory, $acl) | Out-Null
  }
  $acl = Get-Acl -LiteralPath $directory
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $acl.AreAccessRulesProtected) { throw 'Unsafe vault ACL' }
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Shared vault refused' }
  }
  $file = [IO.Path]::Combine($directory, "$OperationId.dpapi")
  if ($Action -eq 'write') {
    $plain = [Console]::In.ReadToEnd()
    if ($plain.Length -gt 32768 -or $plain.Length -eq 0) { throw 'Invalid bundle' }
    $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Array]::Clear($bytes, 0, $bytes.Length)
    $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($encrypted, 0, $encrypted.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [Console]::Out.Write((ConvertTo-Json -InputObject $file -Compress))
  } else {
    if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused' }
    $fileAcl = Get-Acl -LiteralPath $file
    if ($fileAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Foreign bundle refused' }
    foreach ($rule in $fileAcl.Access) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Shared bundle refused' }
    }
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes)) } finally { [Array]::Clear($bytes, 0, $bytes.Length) }
  }
} catch {
  [Console]::Error.WriteLine('Windows QA vault failed; diagnostics withheld.')
  exit 1
}
