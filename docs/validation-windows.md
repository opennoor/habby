# Native Windows validation

Validated locally on 2026-10-03 from branch `feat/hub-satellites`, starting at `c5e753942d4da72209a0b376ba461441b4283e66`. This was the newest remote branch by committer date when cloned. No CI workflows, release publication or AI API calls were invoked.

The host runs Windows 11 Pro x64 (10.0.26300), Tabby 1.0.237, pnpm 11.6.0 and the project's pinned Node 24.21.0. Native Windows PowerShell 5 and PowerShell 7 were exercised. Concurrent native startup can exceed test deadlines on this slow host. UAC is disabled (`EnableLUA=0`): the desktop account and its least-privilege scheduled tasks still have an administrator token. Package/service acceptance under this account does **not** prove ordinary standard-user installation. The ACL fixture explicitly created and verified two separate standard-user tokens.

## Automated and native checks

| Check | Result |
| --- | --- |
| Frozen dependency installation | Passed; lockfile unchanged |
| Full `pnpm check` | 110 tests: 103 passed, seven skipped, zero failures; both typechecks and production builds passed |
| Final supervisor change | Both typechecks/builds passed; installer suite: 11 passed, four platform skips, zero failures |
| Native CMD | All four tests passed with `TABBY_HUB_NATIVE_TEST_TIMEOUT_MS=900000`; assertions and production deadlines unchanged |
| Native PowerShell and command regressions after final console changes | Five passed, zero failures/skips: multiline Unicode input/nonzero exit, formatted objects/errors, early return, unknown CMD outcome, rendered ConPTY completion |
| Two-standard-user ACL fixture | One native test passed, zero skips; the second standard user was denied reads of all seven private state/control files by full path; owner cleanup passed |
| Standard-user installer registration | Bad-checksum rejection and account-scoped Task Scheduler registration passed; scheduled startup could not run without an interactive desktop login for the fixture account |
| Real Tabby 1.0.237 | Two windows, all four split directions, exact five-pane routing, PowerShell execution, incremental output, modal keyboard focus/queued-dialog restoration and Hub survival passed |
| Windows release archive | Built locally using the pinned runtime and verified official checksum; no publication |
| Final packaged installer/real Task Scheduler in logged-in desktop | Checksum rejection, immutable-version rejection, independent bundled runtime, doctor, 38 tools, zero windows, public 401 challenge, actual crash recovery, upgrade preserving identity, uninstall/state retention/unrelated-plugin preservation, absent-task uninstall, deferred startup across 65 seconds and purge all passed |

The full check preceded the final console marker and scheduler recovery refinements; focused native command tests, the installer suite, both typechecks and production builds were rerun afterwards. The seven full-suite skips are Unix permissions/install/link checks, macOS launchd, Fish (unavailable), and POSIX-only command wrappers/ownership. Windows-specific tests ran. The cross-user fixture ran the compiled original test and production modules staged with release dependencies in a public, temporary directory because the repository is inside a private user profile; assertions were unchanged. The fixture removed its accounts and state. Temporary profiles created by Windows are not an installation acceptance claim.

Raw logs remain in the ignored local `logs/` directory: `windows-check-verified.log`, `windows-cmd.log`, `windows-regressions-console.log`, `windows-cross-user-verified.log`, `windows-gui-console-stdout.log`, `windows-gui-console-stderr.log` and release/package logs. The full check took 533.5 seconds. Cross-user test assertions took 186.1 seconds. Logs are evidence for these local runs, not portable build artifacts.

The final archive `tabby-hub-0.1.0-win-x64.tar.gz` has SHA-256 `9b7059ef24ec6d1aebe80ac02b1c929fa4208b24f9f03c5464b65dd3117fa597`. Its runtime source ZIP hash is `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`, checked against Node's official manifest and the repository pin. Final release/build logs are `windows-release-user.log` and `windows-build-user.log`; final package assertions are in `windows-package-recovery-stdout.log`, with empty stderr. The full installer regression suite passed 11 tests with four platform skips after the recovery refinement; account-scoping then passed the focused supervisor regression and both typechecks/builds. Standard-user attempts are recorded in `windows-package-standard.log` and `windows-package-standard-final.log`.

Temporary accounts, the public staging fixture and the temporary wrapper task were removed. The earlier fixture's explicit orphaned read grant was removed from 2,705 repository entries, preserving other ACL rules. Local pnpm tooling is retained under ignored `.cache/tools`; add that directory to PATH if pnpm is not installed globally.

## Defects found and repaired

- Windows PowerShell's legacy output encoding corrupted Unicode file names when `doctor` parsed ACL results as UTF-8. A `café` state path failed before explicitly setting UTF-8 console output and passed afterwards, including the actual two-user access probe.
- Interactive PowerShell/PSReadLine can submit embedded wrapper newlines separately. The user script is now decoded from UTF-8 base64 and dot-sourced in the existing pane from one physical input line. Existing pane environment and early-return semantics remain intact.
- ConPTY supplies cursor edits, soft wraps and redraws rather than complete output lines. On native Windows with an xterm frontend, completion uses the host's rendered buffer and exact nonce, joining soft-wrapped rows. A regression fails against the original raw-stream implementation and passes for partial-marker edits and redraw contamination. Marker output clears trailing prediction cells on real consoles. Raw streams remain available for partial timeout output and frontends without xterm.
- Windows `execFile` cannot launch pnpm `.cmd` shims. Release building now invokes pnpm's current JS entrypoint with Node, and Windows ZIP extraction uses built-in tar.
- A real daemon kill left the scheduled task stopped with result 1 despite `RestartOnFailure`. Windows now uses repeating logon and registration triggers, with `IgnoreNew` preventing duplicate live instances. Deferred `--no-start` installation omits the registration trigger. Microsoft's [registration trigger](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-registrationtrigger-triggergroup-element) and [repetition pattern](https://learn.microsoft.com/en-us/windows/win32/taskschd/repetitionpattern) are native scheduler features; the failed crash attempts are not counted as passes.
- A verified standard-user installer failed with `Access is denied` because its logon trigger covered all users. The trigger is now scoped to the installing account, preserving current-user operation without requesting elevation.
- The native ACL harness now uses explicit UTF-8 manifests and absolute loader/test paths, removes only accounts it created, cleans fixtures when account setup fails, and confines manifest-driven recursive cleanup to its own test root. Its code access grant uses normal inherited ACL propagation rather than redundantly traversing dependencies.
- GUI smoke streaming now follows bounded output cursors, and Electron profile cleanup retries transient file locks. Package acceptance has a repeatable local smoke command that refuses an existing current-user Hub task and uses isolated state, plugins and version directories.

Rendered command output is bounded by Tabby's scrollback. If the start marker has been evicted, completion remains unknown rather than releasing pane ownership based on an incomplete observation. Terminal redraws/cursor motion can affect rendered output; use incremental output tools where the raw stream is required.

## Reproduce

```powershell
pnpm install --frozen-lockfile
$env:TABBY_HUB_NATIVE_TEST_TIMEOUT_MS='900000'
pnpm check
pnpm release win-x64
pnpm smoke:windows-package
$env:TABBY_EXECUTABLE='C:\path\to\Tabby.exe'
$env:TABBY_SMOKE_TIMEOUT_MS='180000'
$env:TABBY_SMOKE_COMMAND_TIMEOUT_MS='180000'
pnpm smoke:tabby
# Administrator fixture setup only; test children are standard users:
.\scripts\windows-native-tests.ps1 -TimeoutSeconds 900
```

The package smoke test consumes a local `0.1.0-win-x64` archive. It requires no existing current-user Hub task and a desktop login for the account running it. Microsoft's [InteractiveToken definition](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type) requires an existing interactive session. A credentialed child process for a temporary standard user did not provide that session: after fixing account-scoped registration, its task was registered but remained unstarted (`0x41303`), and startup timed out. This is not counted as a complete standard-user lifecycle pass. The fixture did not switch the user's desktop or alter logon policy.

Its PATH excludes development Node/pnpm; installed execution uses the bundled runtime. Aggregate installer/start/recovery waits allow up to five minutes on a slow acceptance machine, while individual production helper deadlines remain unchanged. The GUI command deadline is a test parameter (default 30 seconds); this host's acceptance uses 180 seconds. Assertions are unchanged.

## Remaining acceptance

Standard-user package/service operations with UAC enabled, actual logout/login and reboot persistence, Windows ARM64, physical attention/focus behavior, IME and hardware GPU rendering remain unverified. GUI automation launches an isolated profile with GPU disabled. Live SSH/SFTP, deployed public/Funnel phone approval and real AI-client sessions were not part of these local runs. The existing production-release blocker remains until the missing native operational checks pass; the draft release was not published.
