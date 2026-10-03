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

The workspace audit includes host-supplied Tabby/Angular peers and reports advisories in those packages. The release does not ship those host implementations. Keep the Tabby application updated; SSH requires at least Tabby 1.0.214. This is not a claim that the installed host has no vulnerabilities.

The native CMD run covered quoting, metacharacters, percent expansion, UTF-8, nonzero exits, incomplete syntax, early exits, outer-prompt survival, inherited working directory/environment, large payloads, temporary-file cleanup and exact unknown-outcome parsing. The test and its production runtime dependency were bundled from the validated commit for execution with native Windows Node; no mocks or assertion changes were introduced.

The Windows runner's trivial PowerShell startup benchmark varied from 14.9 to 34.8 seconds even after disabling NGen maintenance in its disposable overlay. This makes the runner unsuitable for completing checks with a 30-second production deadline. The timeout failures do not establish an ACL or Task Scheduler correctness defect, and they also do not establish native compatibility. The full Windows suite, two-standard-user access probe, packaged installer, service lifecycle and Tabby GUI still require a usable Windows acceptance machine.

macOS and ARM native acceptance remain unverified. macOS uses the same MCP contracts and satellite code as Linux; its POSIX shell and filesystem behavior provide a basis for expected compatibility. Linux results do not validate macOS LaunchAgent registration, login/restart behavior, default installation paths, Tabby plugin loading, Dock attention or platform permission prompts. Both macOS architectures remain experimental until those checks run on native hardware.

Live phone approval through a deployed Funnel/public URL and real AI-client sessions were not exercised. Local protocol tests cover OAuth/PKCE, passkey verification, scopes, revocation, discovery and the stdio bridge.

A production release is blocked by incomplete native Windows validation. The local VM has no hardware acceleration and is not a substitute for a usable Windows acceptance machine. The failed/time-limited attempts are not counted as passes. macOS/ARM artifacts are experimental until native acceptance; the prepared GitHub release remains a draft.
