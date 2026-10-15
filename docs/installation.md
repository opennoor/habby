# Install and operate Habby

Habby runs as the signed-in user's background service. A separate satellite is loaded in every Tabby window. Closing Tabby leaves the Hub available with zero windows; it does not keep Tabby's shells alive. The service normally stops at OS logout. No administrator permission is required.

Use an up-to-date Tabby application, at least **1.0.214** for SSH: older applications have a [host-key verification vulnerability](https://github.com/advisories/GHSA-8vq4-8hfp-29xh). The satellite uses Tabby's installed SSH and Angular implementations; bundling the Hub does not update or patch those host components. Development type packages and their npm versions do not identify the installed Tabby application version.

## Release archives

Release bundles contain Node **24.21.0**, the compiled Hub and all production dependencies, and the compiled satellite. They do not require global Node, pnpm, npm, a compiler, or a new SSH implementation. Targets are Linux x64/arm64, macOS x64/arm64, and Windows x64/arm64. Linux archives target glibc systems; Alpine/musl is not covered by these bundles.

The checked-in installers consume versioned GitHub releases and `SHA256SUMS`. They never choose an unpinned `latest` release. This repository is private: use an authenticated `gh` installation or download your platform archive and `SHA256SUMS` from the release page and provide the local directory. The initial implementation does not publish releases automatically. A maintainer must upload the workflow's generated archives/checksums/installers to the corresponding GitHub release before online installation can work.

On Linux or macOS, inspect the downloaded `install.sh`, then run:

```sh
VERSION=1.2.1 sh install.sh
# For downloads made in a browser:
VERSION=1.2.1 ARCHIVE_DIR="$HOME/Downloads/tabby-release" sh install.sh
# Portable/custom Tabby profile: pass its userPluginsPath (parent of node_modules).
VERSION=1.2.1 sh install.sh --plugin-dir "/path/to/tabby/plugins"
```

On Windows, inspect the downloaded `install.ps1`, then run it in PowerShell:

```powershell
.\install.ps1 -Version 1.2.1
.\install.ps1 -Version 1.2.1 -ArchiveDir "$HOME\Downloads\tabby-release"
.\install.ps1 -Version 1.2.1 -PluginDir "D:\PortableTabby\plugins"
```

Windows needs the built-in `tar.exe` available on supported Windows 10/11. Scripts install into version-specific user directories and update the supervisor to the new absolute runtime/entrypoint. They preserve previous version directories for explicit rollback. Rerunning the same version refuses to overwrite that version's immutable directory. Different-version upgrades within Habby replace only its satellite and service; unrelated Tabby plugins and Tailscale mappings are retained. Add the printed launcher directory to your user `PATH`, then restart existing Tabby windows once.

When moving from Tabby Hub v1.0.0, run its `tabby-hub uninstall` first, without `--purge`, then install Habby. The new service, satellite, and state directory have different names. The old private state stays in place for rollback; Habby creates new local credentials and does not import old OAuth clients or grants.

Default satellite locations:

| OS | Tabby plugin root |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/tabby/plugins`, or `~/.config/tabby/plugins` |
| macOS | `~/Library/Application Support/tabby/plugins` |
| Windows | `%APPDATA%\tabby\plugins` |

The installed package is `node_modules/tabby-habby`. [Tabby's loader requires the `tabby-` package prefix and a `tabby-plugin` keyword](https://github.com/Eugeny/tabby/blob/master/app/src/plugins.ts), so it appears as **habby** in the installed plugins list after a Tabby restart. The installer removes the earlier undiscoverable `habby-satellite` package. Its `hub-state.json` identifies the private state directory; credentials remain in that state directory. Use `--plugin-dir` for a selected/portable profile whose directory differs. The installer does not edit the rest of Tabby's plugin manifest or existing SSH credentials.

`habby.new_window` opens another Tabby window and returns its `windowId`. With no connected window, the Hub starts Tabby itself. If Tabby is installed outside a standard location, set `TABBY_EXECUTABLE` to its absolute executable path in the Habby service environment.

## Supervisors and troubleshooting

| OS | Supervisor | Check |
| --- | --- | --- |
| Linux | systemd user service, restart on failure | `systemctl --user status habby` |
| macOS | LaunchAgent `com.habby.mcp`, KeepAlive | `launchctl print gui/$(id -u)/com.habby.mcp` |
| Windows | Current-user `HabbyMCP-<username>` scheduled task at logon/registration, repeating every minute with `IgnoreNew` | Task Scheduler; no execution time limit or battery cutoff |

`habby doctor` checks the runtime, private configuration/trust files and trusted listener health. `habby status` reports the running Hub; `habby install --no-start` installs a service definition without starting it now. If a Linux user systemd manager is unavailable, installation reports that error. Run `habby start` from your desktop's user-session startup facility instead; it is a foreground process and needs that facility to supervise it. Do not run it under `sudo` or claim pre-login persistence.

For a custom state directory use `--state-dir /absolute/path` consistently. Service definitions retain the absolute state directory, bundled runtime and entrypoint. Installation never automatically exposes network access.

Local HTTP MCP endpoint: `http://127.0.0.1:4040/mcp` (default). For a stdio-only agent:

```json
{ "mcpServers": { "habby": { "command": "habby", "args": ["bridge", "--url", "http://127.0.0.1:4040/mcp"] } } }
```

The bridge preserves MCP JSON-RPC IDs, notifications, errors and subscriptions through official SDK transports. It does not execute its own shell or replay failed mutations. Public bearer tokens must use HTTPS; provide `HABBY_TOKEN` in the client process environment instead of embedding tokens in URLs or shell command history. Tailnet-only HTTP access is intentionally trusted by the design; see [authentication](authentication.md).

`habby uninstall` removes only the owned supervisor and satellite, retaining private state for a reinstall. `--purge` explicitly removes that state. Version archives/launcher can then be removed from the printed user installation directory. Existing plugins and Tailscale exposure are not removed implicitly.

## Build and verify releases

Development requires pnpm 11.6.0. The project pins its managed Node runtime to 24.21.0:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm release                 # All six targets, build first
pnpm release linux-x64       # One target for a local smoke check
```

The release builder verifies every runtime against both the [official Node checksums](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt) and checked-in expected hashes before extraction. It uses pnpm's hoisted linker and frozen lockfile in an isolated staging directory to preserve shared module identity, including dynamic OAuth imports. Host-only satellite peers and development dependencies are excluded; executable shim directories are removed and dependency symlinks are rejected for Windows portability. Runtime source/hash metadata and Node's license travel in each bundle. Release archives get their own SHA-256 manifest. These are integrity checks, **not code-signing**; the installer trusts the release owner/channel supplying both archive and checksum. No unsigned authenticity claim is made.

Run `pnpm check` locally for fixes and pull requests. Pushing branches or version tags does not start CI tests. To use CI for a future version release, explicitly dispatch the release workflow against its version tag (`gh workflow run release.yml --ref vX.Y.Z`). The workflow requires a `v*` tag, first typechecks, tests and builds on Linux/macOS/Windows, then builds archives as downloadable workflow artifacts and smoke-checks the Linux archive without development dependencies. It has read-only repository permissions and publishes nothing. Automated tests render all supervisor definitions and install/upgrade/uninstall into temporary directories with a fake process runner.

On Linux with Tabby and `xvfb-run` installed, `pnpm smoke:tabby` loads the compiled satellite into an isolated temporary profile. It checks two real windows, new tabs, split panes, native Bash completion and exit status, incremental output and Hub survival after both windows close. Set `TABBY_EXECUTABLE` to override `/opt/Tabby/tabby`. It does not install a supervisor or change the user's Tabby profile.

The same smoke test supports Windows with `TABBY_EXECUTABLE` set to the full path of `Tabby.exe`; it uses a native PowerShell profile. `TABBY_SMOKE_TIMEOUT_MS` controls GUI startup/polling deadlines on slow test machines (default 45000, maximum 600000). `TABBY_SMOKE_COMMAND_TIMEOUT_MS` controls its command deadline (default 30000, maximum 300000). On an isolated Windows test machine, run `scripts/windows-native-tests.ps1` from an administrator shell to create two temporary standard users and verify private-state access across them. `-TimeoutSeconds 900` allows a slower VM more time; the default is 180 seconds. The script removes accounts it created afterwards. If the repository is in a private user profile, stage the tests/runtime/dependencies somewhere those users can traverse and pass `-ProjectRoot` for that checkout or compiled fixture. This elevation is for the cross-user test fixture, not ordinary Hub installation.

After `pnpm build` and `pnpm release win-x64`, `pnpm smoke:windows-package` exercises the local 1.2.1 x64 archive, installer and real Task Scheduler lifecycle. It refuses an existing current-user Hub task and isolates state, plugin and version directories, while retaining an unrelated fixture plugin. Run it on a disposable acceptance account with an existing desktop login; its daemon crash is intentional. Aggregate startup waits allow five minutes on slow hosts. The production helper deadlines remain unchanged. Repeating native triggers recover a stopped/crashed daemon; `IgnoreNew` prevents additional live instances. `--no-start` omits the registration trigger and waits for the next logon.

On macOS, `pnpm smoke:tabby` launches `/Applications/Tabby.app/Contents/MacOS/Tabby` directly and uses Zsh. Set `TABBY_EXECUTABLE` for another application location. It retains the isolated temporary profile and does not register a LaunchAgent or edit the user's profile.

For CPU-emulated Windows, `HABBY_NATIVE_TEST_TIMEOUT_MS=900000` raises the native CMD test process limit (default 30000, maximum 900000). Run `pnpm exec node --import tsx --test tests/cmd.test.ts` with that environment variable set. All four CMD tests passed locally with this setting. This changes only the test harness deadline; command execution assertions and production deadlines remain unchanged.

Local Linux x64 acceptance includes the packaged installer, real systemd registration, crash recovery, upgrade, uninstall and state purge. Native Intel macOS 26.6.2 acceptance now includes Tabby 1.0.237 GUI loading with Bash/Zsh, the packaged installer, real LaunchAgent registration, crash recovery, upgrade, uninstall and purge. Immediate launchd registration during upgrades retries transient exit 5 for up to five seconds after successful unload; other supervisor failures remain visible. See [macOS validation](validation-macos.md) for evidence and remaining login/reboot and interactive checks. Native Windows acceptance now covers the full suite, two-standard-user ACLs and real Tabby GUI execution; see [Windows validation](validation-windows.md) for package/service results and remaining operational checks. All ARM targets remain unverified. Treat platforms without complete native acceptance as experimental.
