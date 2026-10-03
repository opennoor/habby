# v0.1.0 local validation

Validated on 2026-10-03 using pnpm 11.6.0 and Node 24.21.0. No AI API calls or CI test runs were used. Official runtime downloads, the package advisory registry and GitHub publication are ordinary network operations.

| Check | Result |
| --- | --- |
| Linux `pnpm check` | 108 tests: 103 passed, 5 Windows-only skips, 0 failures; both typechecks and production builds passed |
| Native Linux shells | Bash, Fish and PowerShell passed, including early-return command completion |
| Real Linux Tabby 1.0.223 | Two windows, all four split directions, exact pane routing, execution, output streaming, dialog focus and Hub survival passed |
| Real systemd user service | Install, health/doctor, crash recovery, upgrade preserving identity, unregister, state retention and purge passed |
| Packaged Linux installer | Checksum verification, bundled runtime, service startup, immutable-version rejection and complete uninstall passed |
| Independent Linux archive | Empty HOME and clean PATH; startup, doctor, 38 MCP tools, zero-window operation, public authentication challenge and shutdown passed |
| Six release archives | Checksums, pinned runtime metadata, no dependency symlinks and no bundled Tabby/Angular host modules verified |
| Daemon production dependencies | 117 dependencies audited; 0 reported advisories |
| Windows fixture cleanup regression in local PowerShell | Mocked account operations verify ownership; real pre-existing fixture files remain intact. The regression failed when the ownership guard was removed |
| Native Windows CMD (local Windows 10 VM, Node 24.21.0) | All 4 tests passed, 0 failures or skips, in 457.4 seconds; the existing harness deadline was set to 900000 ms. Original assertions and production command handling were unchanged |
| Native Windows state ACL | Three attempts failed when a production PowerShell helper exceeded its unchanged 30-second deadline, including a final attempt with the VM's background NGen maintenance tasks disabled; none is counted as a pass |
| Native Windows Task Scheduler missing-task uninstall | Failed when the real Task Scheduler PowerShell helper exceeded its unchanged 30-second production deadline; no success was reported |
| Windows full suite, standard-user ACL, Task Scheduler lifecycle, packaged installer and GUI | Native acceptance remains incomplete; the CPU-emulated runner has no hardware acceleration |
| Native Intel macOS 26.6.2 `pnpm check` | Final run: 109 tests, 103 passed, 6 skips, 0 failures; both typechecks and production builds passed |
| Real macOS Tabby 1.0.237 | Bash and Zsh, two windows, all four split directions, exact pane routing, execution, output streaming, dialog focus and Hub survival passed |
| Packaged macOS x64 and real LaunchAgent | Checksum rejection, bundled runtime, native paths/permissions, startup, doctor/status, 38 tools, crash recovery, upgrade, state retention, uninstall and purge passed; [detailed evidence and boundaries](validation-macos.md) |

The workspace audit includes host-supplied Tabby/Angular peers and reports advisories in those packages. The release does not ship those host implementations. Keep the Tabby application updated; SSH requires at least Tabby 1.0.214. This is not a claim that the installed host has no vulnerabilities.

The native CMD run covered quoting, metacharacters, percent expansion, UTF-8, nonzero exits, incomplete syntax, early exits, outer-prompt survival, inherited working directory/environment, large payloads, temporary-file cleanup and exact unknown-outcome parsing. The test and its production runtime dependency were bundled from the validated commit for execution with native Windows Node; no mocks or assertion changes were introduced.

The Windows runner's trivial PowerShell startup benchmark varied from 14.9 to 34.8 seconds even after disabling NGen maintenance in its disposable overlay. This makes the runner unsuitable for completing checks with a 30-second production deadline. The timeout failures do not establish an ACL or Task Scheduler correctness defect, and they also do not establish native compatibility. The full Windows suite, two-standard-user access probe, packaged installer, service lifecycle and Tabby GUI still require a usable Windows acceptance machine.

Native Intel macOS operational checks now pass on macOS 26.6.2 with Tabby 1.0.237. The check found and fixed transient launchd registration failure during upgrades; the new regression failed before the fix, and the final packaged lifecycle passed without fixture retries. These results cover default installation paths under an isolated HOME, Tabby plugin loading and actual LaunchAgent registration/crash recovery. Actual logout/login/reboot, physical Dock attention, IME, hardware graphics and platform permission prompts remain unverified. Apple Silicon and other ARM targets still require native hardware acceptance. See the [macOS report](validation-macos.md) for exact scope.

Live phone approval through a deployed Funnel/public URL and real AI-client sessions were not exercised. Local protocol tests cover OAuth/PKCE, passkey verification, scopes, revocation, discovery and the stdio bridge.

A production release is blocked by incomplete native Windows validation. The local VM has no hardware acceleration and is not a substitute for a usable Windows acceptance machine. The failed/time-limited attempts are not counted as passes. ARM artifacts remain experimental until native acceptance; Intel macOS operational checks pass with the manual acceptance limits above. The prepared GitHub release remains a draft.
