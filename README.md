# tabby-hub-mcp

One MCP endpoint for all your Tabby windows. A standalone Node daemon routes
requests to a satellite plugin in each window, preserving its tabs, panes,
profiles, terminals and SFTP sessions.

## Run from source

Use **pnpm 11.6.0**; pnpm downloads the pinned Node 24.21.0 runtime.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec node dist/packages/hub/src/cli.js install
```

Restart Tabby windows after installation. Connect an HTTP MCP client to
`http://127.0.0.1:3001/mcp`, or use `tabby-hub bridge` for a stdio client.
Run `pnpm exec node dist/packages/hub/src/cli.js --help` for the source CLI.

The Hub exposes all **36 upstream tools**, plus `list_windows` and bounded
`read_terminal_output`. Target IDs include their owning window; ambiguous
requests fail instead of selecting another window. The Hub remains available
when Tabby is closed, with no connected terminal sessions.

Monitored CMD commands use batch syntax (for example, `for %%i`) in a child CMD
process, launched by Windows PowerShell, so malformed syntax cannot consume
completion markers. Changes to that child's
directory or environment do not persist in the pane; use `send_input` for those
changes or interactive commands. A zero exit without the completion probe,
including unfinished syntax or an early `exit /b 0`, reports `OUTCOME_UNKNOWN`.

Local clients need no authentication. `tabby-hub expose tailnet` enables trusted
direct Tailnet access. Public HTTPS and Funnel access uses OAuth authorization
code flow with PKCE, passkey owner approval, scopes and revocable grants;
`tabby-hub expose public --url https://HOST/PREFIX/mcp --funnel` configures it.
Installation does not expose network access automatically.

## Installation and design

- [Installation, packaged runtimes and operations](docs/installation.md)
- [Architecture](docs/architecture.md)
- [Tabby-MCP capability inventory](docs/tabby-mcp-capabilities.md)
- [Authentication and network boundaries](docs/authentication.md)
- [v0.1.0 local validation and release blockers](docs/validation-0.1.0.md)

Release tooling builds bundles for Linux, macOS and Windows, on x64 and arm64.
The Linux acceptance check (`pnpm smoke:tabby`, with Tabby and Xvfb installed)
exercises two real windows, new tabs, split panes, shell execution, output streaming
and Hub survival. Linux x64 installation and the real systemd service lifecycle
also pass local acceptance. macOS/Windows GUI, their native supervisors and ARM
targets remain experimental pending native acceptance. MCP routing, TLS, OAuth/passkeys and installer behavior have
automated coverage.

## License

[MIT](LICENSE)
