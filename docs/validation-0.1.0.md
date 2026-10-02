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
| Native Windows CMD (local Windows 10 VM, Node 24.21.0) | Quoting/metacharacters/UTF-8 passed with a longer harness deadline; two multi-command tests still timed out at 300 seconds |
| Windows full suite, standard-user ACL and GUI | Blocked: the CPU-emulated runner could not finish staging dependencies; native archive extraction timed out at 600 seconds |

The workspace audit includes host-supplied Tabby/Angular peers and reports advisories in those packages. The release does not ship those host implementations. Keep the Tabby application updated; SSH requires at least Tabby 1.0.214. This is not a claim that the installed host has no vulnerabilities.

macOS and ARM native acceptance remain unverified. Live phone approval through a deployed Funnel/public URL and real AI-client sessions were not exercised. Local protocol tests cover OAuth/PKCE, passkey verification, scopes, revocation, discovery and the stdio bridge.

A production release is blocked by incomplete native Windows validation. The local VM has no hardware acceleration and is not a substitute for a usable Windows acceptance machine. The failed/time-limited attempts are not counted as passes. macOS/ARM artifacts are experimental until native acceptance; the prepared GitHub release remains a draft.
