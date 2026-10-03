# v1.0.0 release validation

Prepared locally on 2026-10-03 with pnpm 11.6.0 and pinned Node 24.21.0. The Hub and satellite manifests, MCP initialization/health responses, satellite registration and Windows package smoke target all report `1.0.0`. Dependencies remain frozen to the existing lockfile. No AI API calls or CI test runs were used.

## Fresh release checks

| Check | Result |
| --- | --- |
| Linux `pnpm check` with Bash, Fish and PowerShell available | 110 tests: 104 passed, six Windows-only skips, zero failures; both typechecks and production builds passed |
| Real Linux Tabby smoke | Two windows, new tabs, all split directions, exact pane execution, incremental output, modal keyboard focus/queued-dialog restoration and Hub survival passed |
| Six fresh archives | Linux, macOS and Windows on x64/arm64; each archive's 51 application files match the current build/manifests/licenses byte-for-byte |
| Runtime/package integrity | Official and checked-in Node runtime hashes verified; binary architectures match archive targets; both package manifests report 1.0.0; no symlinks, hardlinks or bundled Tabby/Angular host modules |
| Independent Linux x64 archive | Empty HOME and clean PATH; bundled runtime, startup/status/doctor, health and MCP version 1.0.0, 38 tools, zero-window operation, public 401 challenge and clean shutdown passed |
| Real Linux packaged installer | Local checksum verification, bundled runtime, systemd startup, doctor, immutable-version rejection, identity retention and complete uninstall/purge passed |
| Installer shell syntax | `sh -n scripts/install.sh` passed |
| Fresh daemon dependency audit | 117 production dependencies, zero reported advisories; host-supplied Tabby/Angular peers excluded |

The release includes six `tabby-hub-1.0.0-<platform>-<architecture>.tar.gz` archives, `SHA256SUMS`, `install.sh` and `install.ps1`. Checksums establish integrity; these packages are not code-signed. Verify the manifest obtained through the trusted release channel before installation.

## Native validation carried into this release

The [Windows](validation-windows.md), [Intel macOS](validation-macos.md) and [earlier Linux/platform](validation-0.1.0.md) reports retain the native results, failed attempts and exact environments for the implementation included here. Windows covers native CMD/PowerShell, two-standard-user state ACLs, real Tabby, and packaged Task Scheduler operation under the logged-in desktop account. Intel macOS covers Bash/Zsh, real Tabby and the packaged LaunchAgent lifecycle.

Those native runs preceded the 1.0.0 metadata bump. Fresh 1.0.0 archives for Windows/macOS and all ARM targets were inspected for integrity, compiled-code identity and architecture here; they were not executed on those OSes during this release preparation. No additional native coverage is inferred from rebuilding them.

## Known limits

- Windows full package/service lifecycle with UAC enabled under an ordinary standard-user desktop account remains unverified. Standard-user registration and the separate two-user ACL fixture passed; the complete packaged lifecycle ran under an administrator-token desktop account with UAC disabled.
- Actual logout/login and reboot persistence, physical OS attention/focus behavior, IME, hardware GPU rendering and platform permission prompts remain unverified. GUI automation uses isolated profiles and disables GPU.
- Apple Silicon, Windows ARM64 and Linux ARM64 remain experimental until native acceptance. Linux archives require glibc; Alpine/musl is not covered.
- Live SSH/SFTP hosts, deployed public HTTPS/Tailscale Funnel phone approval and real AI-client sessions were not exercised by these local runs. Protocol/authentication and transfer failure handling have automated coverage.
- Rendered Windows command completion is bounded by Tabby's scrollback. If a start marker is evicted, the outcome remains unknown; use incremental output tools when raw terminal bytes are required. Monitored CMD runs in a child shell, so cwd/environment changes do not persist in the pane.

Keep Tabby and its host-supplied Angular/SSH components updated independently. The daemon bundle does not include those host implementations.
