# macOS validation — 2026-10-03

Status: **native Intel macOS operational checks passed**. Apple Silicon and the interactive checks listed below remain unverified.

## Environment

- macOS 26.6.2, build 25G83; Darwin 25.6.0, Intel x86_64.
- Tabby 1.0.237 at `/Applications/Tabby.app/Contents/MacOS/Tabby`.
- pnpm 11.6.0 with its pinned Node 24.21.0 (`darwin`, `x64`). The global Node is 22.23.1 and was not used for acceptance.
- Base revision `339acc4b979d42404bc30932fb2e2d529f2ffde0`, plus the macOS smoke support, launchd fix and regression test in this working tree.

No CI workflow, release publication or AI-client session was invoked. Dependency and official Node-runtime downloads were used. Tests requiring localhost listeners ran outside the filesystem/network sandbox; a sandbox-restricted attempt was not counted as a platform failure or pass.

## Checks

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed with the existing lockfile and pinned runtime |
| Final `pnpm check` | 109 tests: 103 passed, 6 skipped, 0 failed; both typechecks and production builds passed |
| `sh -n scripts/install.sh` | Passed using the native shell |
| Real Tabby GUI | Bash and Zsh runs passed: two windows, satellite loading, 38 MCP tools, new tabs, all four split directions, exact pane routing, command output streaming, modal keyboard focus/queued restoration and Hub survival after both windows close |
| `pnpm release darwin-x64` | Passed; official runtime checksum and checked-in expected hash verified before bundling |
| Packaged installer | Passed: bad-checksum rejection, native BSD tools/`shasum` fallback, bundled runtime, default paths under isolated HOME, spaces/XML/Unicode paths, private modes, `--no-start`, immutable-version rejection and dependency isolation |
| Independent packaged daemon | Passed: clean system PATH without Node/pnpm, startup, health/doctor/status, 38 MCP tools, zero-window operation and public authentication challenge |
| Native LaunchAgent | Passed: bootstrap, KeepAlive crash recovery, replacement using a new absolute runtime/entrypoint, identity/unrelated-plugin retention, bootout, state-retaining and absent-service uninstall, reinstall and explicit purge |
| Fixture cleanup | Passed: final process exit 0, test registration absent afterward and temporary home removed |

The six skips are three native CMD cases, Windows Task Scheduler missing-task uninstall, Windows state ACLs, and Fish (not installed). The native PowerShell checks available on this Mac passed. Skips do not establish compatibility for those unavailable cases.

The final archive is `tabby-hub-0.1.0-darwin-x64.tar.gz`, SHA-256 `2efeda2d79c85a7e6f187c02e1491d765bb8e05e93565e3289990ab160a55010`. Its Node 24.21.0 source archive hash is `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097`. These hashes identify this local build; rebuilding need not produce identical archive bytes.

## Compatibility change

The GUI acceptance script previously rejected macOS. It now launches the native Tabby executable directly, uses Zsh on macOS, and retains the existing assertions, temporary profile and POSIX process-group cleanup. Linux continues to use Xvfb; Windows continues to use PowerShell.

Native launchd acceptance exposed an upgrade failure: `bootout` succeeded, but immediate `bootstrap` returned exit 5 (`Input/output error`). The replacement plist passed `plutil`, the previous daemon had exited, and a later registration succeeded. The installer now retries this error for up to five seconds, with 100 ms between attempts, only after a successful unload. Missing-service exit 3 is accepted; other unload errors and unrelated registration errors surface immediately. Persistent registration failures still fail installation.

The regression test failed against the original installer and passed with the fix. It covers transient recovery, denied registration, denied unload, fresh-install failure without retry, and bounded persistent upgrade failure. The final native acceptance fixture has no retry around the upgrade CLI command. An independent read-only code review found no actionable correctness or security issues.

## Native fixture and boundaries

The packaged acceptance probe uses a temporary home with spaces, an ampersand and Unicode, unused local ports, and the native `/usr/bin:/bin:/usr/sbin:/sbin` PATH. The archive supplies the daemon's Node and dependencies. A development SDK client probes that independent daemon. Production installer, CLI and `launchctl` commands are used without a fake supervisor runner. The probe refuses to replace an existing `com.tabby-hub.mcp` service and removes its own registration and temporary files afterward.

The upgrade probe moves the same build into another immutable directory and installs its new absolute runtime/entrypoint. It verifies replacement behavior and identity retention, rather than a change between two separately published versions.

Still unverified:

- Apple Silicon (`darwin-arm64`), other macOS versions and other Tabby versions.
- Automatic registration after actual logout/login or reboot; acceptance bootstraps the isolated plist into the current GUI session.
- Physical Dock attention, IME interaction, hardware GPU rendering and macOS permission/Gatekeeper prompts. The GUI smoke disables GPU and stubs OS attention in its modal-focus fixture.
- Live SSH/SFTP hosts, deployed Tailscale/Funnel/HTTPS, phone passkey approval and real AI-client sessions.

Existing Windows native release blockers remain. This report does not approve or publish the draft release.

## Repeat the source and GUI checks

```sh
pnpm install --frozen-lockfile
pnpm check
sh -n scripts/install.sh
pnpm smoke:tabby
pnpm release darwin-x64
```

Set `TABBY_EXECUTABLE` if Tabby is installed elsewhere. `pnpm smoke:tabby` uses an isolated profile and does not install a supervisor or edit the user's Tabby profile. Packaged/native supervisor acceptance must use an isolated home/state/plugin tree and confirm the fixed production service label is unused before registration.
