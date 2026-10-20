# Restore authorized VPS SSH access from Windows

Use this procedure only to identify and test an existing authorized identity.
It does not generate keys, change server authentication, or weaken host-key
verification. The repository documents the SSH aliases `truevinevoice_contabo`
and `truevine_voice_admin`; earlier read-only attempts were rejected, so the
identity must be rechecked with the server operator before any key is installed.

## Inspect local files without reading private keys

In PowerShell, list filenames and metadata only:

```powershell
$sshDir = Join-Path $env:USERPROFILE '.ssh'
Get-ChildItem -LiteralPath $sshDir -Force -ErrorAction SilentlyContinue |
  Select-Object Name, Length, LastWriteTime, Attributes
Get-ChildItem -LiteralPath $sshDir -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'truevine|contabo|vps|admin|deploy' } |
  Select-Object Name, Length, LastWriteTime
```

Inspect standard OpenSSH configuration and known-host filenames without
printing their contents:

```powershell
Get-Item -LiteralPath (Join-Path $sshDir 'config'),
  (Join-Path $sshDir 'known_hosts') -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime
Get-ChildItem -LiteralPath $sshDir -Directory -Force -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty Name
```

Also check the repository's documented aliases and deployment metadata without
opening any secret value:

```powershell
rg -n 'truevinevoice_contabo|truevine_voice_admin|HostName|User |Port |IdentityFile' `
  docs/runbooks docs/adr .github/workflows
```

Do not run `Get-Content` against a private key. `ssh-add -l` lists agent key
fingerprints without revealing key material:

```powershell
ssh-add -l
```

## Resolve alias configuration and test safely

For each documented alias, inspect only OpenSSH's resolved non-secret settings:

```powershell
ssh -G truevinevoice_contabo |
  Select-String '^(hostname|user|port|identityfile|identitiesonly|userknownhostsfile|stricthostkeychecking) '
ssh -G truevine_voice_admin |
  Select-String '^(hostname|user|port|identityfile|identitiesonly|userknownhostsfile|stricthostkeychecking) '
```

Check that the resolved identity path exists, without opening it:

```powershell
Test-Path -LiteralPath '<identityfile path returned by ssh -G>'
```

Then test one existing alias in batch mode. This sends a read-only command and
requires the existing known-host entry; it cannot prompt to trust a new host:

```powershell
ssh -vv -o BatchMode=yes -o IdentitiesOnly=yes `
  -o StrictHostKeyChecking=yes -o ConnectTimeout=10 `
  truevinevoice_contabo 'printf "authorized SSH read-only probe succeeded\n"'
```

Use the other alias only if its resolved host/user/port are documented as the
same authorized VPS target. Review the `-vv` output locally; it contains file
paths and authentication diagnostics, so redact before sharing. Never add
`StrictHostKeyChecking=no`, never accept a fingerprint based only on
`ssh-keyscan`, and never generate a replacement key as part of diagnosis.

If the existing key is found but the server replies `Permission denied`, stop
after confirming the intended account and key fingerprint with the VPS owner.
Ask the authorized server administrator to confirm whether that public key is
still present for that account using the Contabo console or existing admin
access. Do not reinstall or replace a key until the VPS owner explicitly
authorizes the precise public-key recovery change. If no private key exists,
check only the owner's approved encrypted password manager/offline backup; do
not search or copy private-key contents into chat, GitHub, or this repository.

Successful authentication proves access only. Continue with read-only commands
and do not restart services, alter files, run migrations, create backups, or
access customer rows without separate authorization.
