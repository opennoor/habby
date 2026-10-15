# Habby

One MCP endpoint for all your Tabby windows. A standalone Node daemon routes
requests to a satellite plugin in each window, preserving its tabs, panes,
profiles, terminals and SFTP sessions.

[Download v1.2.1](https://github.com/Sojaner/habby/releases/tag/v1.2.1)
for bundled Node runtimes, the Hub and the satellite plugin. See the
[installation instructions](docs/installation.md) and [previous release validation](docs/validation-1.0.0.md).

## Run from source

Use **pnpm 11.6.0**; pnpm downloads the pinned Node 24.21.0 runtime.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec node dist/packages/hub/src/cli.js install
```

Restart Tabby windows after installation. Connect an HTTP MCP client to
`http://127.0.0.1:4040/mcp`, or use `habby bridge` for a stdio client.
Run `pnpm exec node dist/packages/hub/src/cli.js --help` for the source CLI.

The Hub exposes all **36 upstream tools**, plus `list_windows`, bounded
`read_terminal_output`, and `habby.new_window`. The new-window tool starts Tabby
when needed and returns a window ID for subsequent calls. Target IDs include their owning window; ambiguous
requests fail instead of selecting another window. The Hub remains available
when Tabby is closed, with no connected terminal sessions.

Monitored CMD commands use batch syntax (for example, `for %%i`) in a child CMD
process, launched by Windows PowerShell, so malformed syntax cannot consume
completion markers. Changes to that child's
directory or environment do not persist in the pane; use `send_input` for those
changes or interactive commands. A zero exit without the completion probe,
including unfinished syntax or an early `exit /b 0`, reports `OUTCOME_UNKNOWN`.

Local clients need no authentication. `habby expose tailnet` enables trusted
direct Tailnet access. Public HTTPS and Funnel access uses OAuth authorization
code flow with PKCE, passkey owner approval, scopes and revocable grants;
`habby expose public --url https://HOST/PREFIX/mcp --funnel` configures it.
Installation does not expose network access automatically.

## Installation and design

- [Installation, packaged runtimes and operations](docs/installation.md)
- [Architecture](docs/architecture.md)
- [Tabby-MCP capability inventory](docs/tabby-mcp-capabilities.md)
- [Authentication and network boundaries](docs/authentication.md)
- [Previous v1.0.0 validation and known limitations](docs/validation-1.0.0.md)
- [Native macOS validation and remaining acceptance](docs/validation-macos.md)
- [Native Windows validation and remaining acceptance](docs/validation-windows.md)

Release tooling builds bundles for Linux, macOS and Windows, on x64 and arm64.
The Linux acceptance check (`pnpm smoke:tabby`, with Tabby and Xvfb installed)
exercises two real windows, new tabs, split panes, shell execution, output streaming
and Hub survival. Linux x64 installation and the real systemd service lifecycle
also pass local acceptance. Native Intel macOS checks pass with Tabby 1.0.237,
Bash/Zsh, the packaged installer and the LaunchAgent lifecycle, including crash
recovery and upgrade. Native Windows checks now cover the full suite,
two-standard-user state ACLs and real Tabby PowerShell/pane operation.
Apple Silicon, other ARM targets and remaining Windows operational acceptance
are unverified; platform login/reboot and interactive checks
are listed in the validation report. MCP routing, TLS, OAuth/passkeys and installer behavior have
automated coverage.

## License

[MIT](LICENSE)
