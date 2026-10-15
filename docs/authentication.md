# Hub authentication and network boundaries

Research date: **2026-10-02**. The Hub implements these authentication boundaries;
see [installation](installation.md) for configuration and verification limits.
Primary-source facts are cited inline. Choices marked **Recommendation** are design inferences.

## Recommendation

Use **OAuth authorization code with PKCE** for public MCP clients, with a single-owner **passkey login and consent page**. Package an established authorization-server implementation with the Hub; do not implement OAuth from scratch. The same Node daemon can host the authorization server and MCP resource server as distinct routers.

Local agents and agents reaching a dedicated port through Tailscale Serve need no application token. Public HTTP ingress, including Funnel, always requires a Hub access token. Select this policy by the listener receiving the request, never by an HTTP header or the apparent loopback address of a proxy.

## MCP and SDK facts

- The current `latest` specification redirects to **2026-07-28**. HTTP authorization uses OAuth 2.1; the Hub is a resource server and publishes RFC 9728 protected-resource metadata. Tokens must be bound to the Hub resource; clients send `resource` in authorization and token requests and a bearer token on every protected HTTP request. Tokens cannot appear in query strings. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- OAuth discovery must lead to RFC 8414 authorization-server metadata or OpenID Connect discovery. Send a `401` challenge containing `resource_metadata`; advertise the authorization server and an appropriate minimum scope. [MCP discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)
- Clients must use PKCE, normally `S256`; the authorization server must advertise `code_challenge_methods_supported`. Authorization endpoints require HTTPS, redirect URIs require HTTPS or localhost, and redirects must match registered values. Public-client refresh tokens require rotation. [MCP authorization security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- Current client registration prefers existing pre-registration, then Client ID Metadata Documents (CIMD), then Dynamic Client Registration (DCR). DCR remains available for compatibility but is deprecated in the current specification. CIMD support needs SSRF-safe metadata fetching and redirect validation; possession of a client ID is not owner approval. [MCP client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
- The official TypeScript **v2** SDK is now the stable line, implementing 2026-07-28. It uses `@modelcontextprotocol/server` and `@modelcontextprotocol/client`; v1 continues receiving fixes for at least six months after v2's release. [Official SDK repository](https://github.com/modelcontextprotocol/typescript-sdk)
- The SDK's `createMcpHandler` serves both modern and 2025-era stateless HTTP requests. Directly constructed clients default to the older handshake unless negotiation is enabled. Use SDK compatibility support rather than constructing another wire protocol. [SDK protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)
- Modern HTTP sends changes on a client-initiated `subscriptions/listen` response stream, with SSE scoped to requests. This differs from the older long-lived session notification pattern. Baseline terminal tools should always support bounded reads with a cursor; optional change subscriptions must follow the negotiated protocol/client capabilities. A satellite's full-duplex WebSocket is independent of either MCP transport. [Current HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

## Four connection paths

These example ports are configuration defaults, not protocol constants.

| Path | Listener / ingress | Application policy |
| --- | --- | --- |
| Local agent | `http://127.0.0.1:4040/mcp` | No token; local/trusted agent tools only |
| Direct Tailnet agent | `http://<host-Tailscale-IP>:4040/mcp`, TCP-forwarded by Tailscale Serve to `127.0.0.1:4040` | No token; Tailscale grants enforce who can reach it |
| Satellite | `wss://127.0.0.1:3002/satellite` | Pinned local TLS plus per-user registration credential; window-bound routing |
| Public agent | Trusted HTTPS reverse proxy or Funnel → `127.0.0.1:3003` | OAuth bearer required on every MCP request, including proxy-originated loopback traffic |

**Recommendation:** share tool dispatch internally, with explicit listener policy at ingress. Agent listeners do not expose satellite registration or unauthenticated administrative routes. The public listener exposes necessary public discovery/login routes, protects consent and management with owner authentication, and protects MCP with bearer authorization.

Tailscale Serve supports raw TCP forwarding on any valid port, so the portable trusted route can be installed as:

```sh
tailscale serve --bg --tcp=4040 tcp://127.0.0.1:4040
```

Agents still connect directly to the host's Tailnet IP and MCP port. Tailscale handles encrypted ingress, device authentication and grants before forwarding the HTTP bytes. This avoids depending on platform-specific Node socket/interface binding. [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve), [Tailscale identity](https://tailscale.com/docs/concepts/tailscale-identity)

**Recommendation:** only create the Serve mapping to the agent listener, and only create Funnel/public-proxy mappings to the OAuth listener. Inspect existing configuration first, preserve other services, and verify resulting mappings in the installation diagnostic. Do not run `serve reset` or `funnel reset` as part of ordinary installation.

Funnel accepts public ports **443, 8443 and 10000**, rather than arbitrary port 4040. Serve and Funnel share configuration: a port cannot simultaneously be private Serve and public Funnel; the most recent configuration determines exposure. A Funnel route must never target 4040 or 3002, including through an intermediate proxy. [Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel), [Serve limitations](https://tailscale.com/docs/features/tailscale-serve)

**Recommendation:** use a grant permitting the owner's devices and explicitly approved agent tags to reach `tcp:4040`. Other policy rules are additive, so an existing allow-all grant still permits other devices. Sharing a device with someone does not automatically make them an intended terminal administrator. Use network policy deliberately. [Grants syntax](https://tailscale.com/docs/reference/syntax/grants)

Example policy fragment, to merge with the existing tailnet policy rather than replace it:

```json
{
  "grants": [
    {
      "src": ["owner@example.com", "tag:mcp-agent"],
      "dst": ["tag:habby"],
      "ip": ["tcp:4040"]
    }
  ]
}
```

Tag ownership must also be configured in the tailnet policy. Tagged unattended agents should be authorized by tag/node policy; they do not carry a human user identity. [Tailscale identity](https://tailscale.com/docs/concepts/tailscale-identity)

## Direct binding alternative and identity lookup

**Recommendation:** prefer the Serve TCP route above for the first release. If the Hub later listens on its assigned Tailnet IPs itself, require an ingress restriction to the Tailscale interface plus verification using the actual socket peer. Merely binding an IP or recognizing a familiar address range is not a complete identity check.

- Do not trust all of `100.64.0.0/10`, the Tailscale IPv6 prefix, private LAN ranges, `X-Forwarded-For`, `X-Real-IP`, or client-supplied Tailscale headers.
- Read the actual socket source IP and port, normalize IPv4-mapped IPv6, and ask the local Tailscale daemon for the peer identity. Require an allowed node/user/tag; do not equate a successful lookup with authorization for shell control.
- The portable CLI is `tailscale whois --json --proto=tcp <IP:port>`; use `execFile` with an argument array and a timeout, never a shell command assembled from request text. IPv6 addresses with ports need bracketed formatting. [Official CLI](https://tailscale.com/docs/reference/tailscale-cli), [CLI source](https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/whois.go)
- `WhoIs` is a stable LocalAPI operation. LocalAPI transports differ by platform: Unix socket, Windows named pipe, and macOS GUI variants' discovered local TCP port plus token. The official CLI already handles these differences. A fixed Linux socket path is not a cross-platform design. [Official LocalAPI client source](https://github.com/tailscale/tailscale/blob/main/client/local/local.go)

Serve HTTP identity headers are stripped/replaced by Tailscale, but Funnel has no Tailnet user headers and tagged nodes have no human-user headers. Headers are trustworthy only behind the controlled local Serve proxy. The proposed raw TCP ingress does not need them to choose authentication policy. [Serve identity headers](https://tailscale.com/docs/features/tailscale-serve)

**Recommendation:** absent Tailscale or unavailable identity verification must never downgrade public access. Keep local agents and satellites operating, disable the trusted Tailnet route, expose its unavailable status, and retry availability in the background. OAuth public access remains governed by the public listener.

## Public authentication and phone approval

**Recommendation:** use an embedded **`oidc-provider`** instance for OAuth machinery, and **SimpleWebAuthn** for the owner's passkey login. These are security dependencies with defined jobs, not a new application framework. Configure persistent grants/tokens, disable example login pages, and expose only the required authorization features.

`oidc-provider` implements PKCE, RFC 8414/OIDC discovery, dynamic registration, resource indicators, token revocation/introspection, issuer identification, device flow and CIMD. Features are not all enabled by default. Match its supported CIMD draft and metadata behavior against the clients being shipped. [Provider implementation](https://github.com/panva/node-oidc-provider)

The current MCP SDK supplies bearer verification and protected-resource metadata; its older authorization-server helpers are frozen in a legacy package. It recommends a dedicated identity provider for new implementations. The resource-server verifier must validate audience, expiry and scopes; SDK middleware does not create the owner's login system. [SDK authorization guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)

Proposed owner flow:

1. Local setup configures a stable public HTTPS URL and generates a short-lived, one-use owner-enrollment link. Enrollment requires this locally generated secret; there is no public “first visitor becomes owner” route.
2. Open that link on the phone or home computer and register an owner passkey. Register a second authenticator and retain offline recovery codes before discarding the bootstrap secret.
3. An agent adds the public MCP URL. Its client discovers OAuth, creates a PKCE challenge, and opens the Hub authorization page.
4. The owner signs in with a passkey and reviews the client, redirect hostname, requested permissions, target host and expiry. Approval issues an authorization code bound to the pending request, redirect, client, resource and PKCE challenge.
5. The client redeems the code and stores its own access/refresh tokens. The owner can revoke this agent grant without affecting other agents.

Passkeys can be synchronized by a platform/password manager, but availability across unrelated ecosystems is not universal. WebAuthn verifies challenge, relying-party ID and origin. Use the stable public hostname as the relying party and require user verification; a localhost-enrolled passkey does not automatically work on the Funnel hostname. Renaming that hostname requires a controlled credential migration or re-enrollment. [SimpleWebAuthn passkeys](https://simplewebauthn.dev/docs/advanced/passkeys), [Server verification](https://simplewebauthn.dev/docs/packages/server)

**Recommendation:** allow approving a desktop-agent request on the phone by showing a QR/short approval code on the original authorization page. The phone approves the same pending OAuth transaction; the original page then completes the registered callback. No access token or PKCE verifier appears in the QR. This is authorization-server UI, so the agent still uses standard authorization code + PKCE.

A phone cannot deliver a desktop client's `http://localhost:<port>/callback` by navigating to that URL itself: its localhost is the phone. Keep the original desktop page alive for its own callback. A fully headless client can use a named expiring token, or RFC 8628 device flow only when that client explicitly supports it. Device flow is not required by the core MCP authorization specification. [OAuth device authorization grant](https://www.rfc-editor.org/rfc/rfc8628.html), [MCP client OAuth flow](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/oauth.md)

**Recommendation:** maintain revocable per-agent grants with `terminal:read`, `terminal:write`, `terminal:manage`, `files:read` and `files:write`. Owner administration is a separate permission. SFTP directory/stat and transfer-status reads require `files:read`; file mutations and transfer cancellation require `files:write`. Uploads and downloads require both file scopes because their local and remote effects include reading and writing. Constrain grants to selected windows where useful; enforce constraints on every tool/resource operation, rather than only filtering `tools/list`. A terminal write grant permits arbitrary commands, including file operations, as the terminal user. These scopes govern API operations; they are not a shell sandbox.

Use short-lived opaque access tokens with server-side audience/scope/grant checks for straightforward revocation. Persist only token hashes where practical. Rotate refresh tokens and reject reuse. Terminate active subscriptions and deny new reads/writes on revocation or token expiry; a previously authenticated stream must not run forever after its grant disappears.

Environment inspection is read-only only in passive mode. Upstream active detection injects terminal input, so it additionally requires `terminal:write` and applicable satellite confirmation; a read-only grant must never silently trigger that probe.

**Recommendation:** offer a manually issued, named, scoped, expiring bearer token only for clients that support custom Authorization headers but lack usable OAuth. Keep it out of URLs, logs, QR screenshots and shared config files. It uses the same authorization checks and revocation UI. This is a compatibility fallback, not a substitute for publishing MCP OAuth discovery.

## Funnel path prefixes and HTTPS URLs

For an illustrative external base `https://host.example.ts.net/tabby`:

| Item | Public URL |
| --- | --- |
| MCP resource/audience | `https://host.example.ts.net/tabby/mcp` |
| Authorization-server issuer | `https://host.example.ts.net/tabby/oauth` |
| Protected-resource metadata | `https://host.example.ts.net/.well-known/oauth-protected-resource/tabby/mcp` |
| RFC 8414 authorization metadata | `https://host.example.ts.net/.well-known/oauth-authorization-server/tabby/oauth` |
| Browser authorization/token routes | Below the configured `/tabby/oauth` issuer |

RFC 9728 inserts the well-known segment **before** a resource's path; RFC 8414 discovery likewise inserts it before an issuer path. These metadata URLs lie outside a `/tabby` proxy mount. Publish additional public well-known routes to the OAuth backend, as well as the mounted application routes. [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html), [MCP authorization discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)

Tailscale's proxy strips the mount prefix before forwarding. Define one explicit external URL and internal path mapping for each public route. Construct discovery documents, cookies, form actions and redirects from configured external URLs; never from an arbitrary incoming `Host` or forwarding header. [Tailscale proxy source](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go)

**Recommendation:** the installer checks MCP, both metadata documents, login/consent, callback and token exchange through the actual public URL, including path mount and SSE behavior. A working `/tabby/mcp` alone does not prove OAuth works. Public-IP exposure needs trusted HTTPS termination as well; HTTP plaintext is not an acceptable OAuth deployment.

## Satellite trust and browser protection

**Recommendation:** the installer generates a local TLS certificate/private key, with loopback IP/hostname identities, and an independent random **256-bit registration credential**. Persist the private key and credential in private state (Unix directory 0700/file 0600; restrictive Windows ACL), alongside the certificate/private trust anchor and SPKI or certificate pin distributed privately to that user's satellite. Validate ownership/permissions and reject unsafe locations or symlink substitutions. Use an established certificate-generation dependency bundled with setup rather than requiring platform OpenSSL commands.

The satellite validates the Hub's TLS chain against its private trust anchor, certificate validity and loopback identity, and the saved pin **before sending** an `Authorization: Bearer` registration header in the WebSocket upgrade. Keep certificate validation enabled; extend Node's default hostname check when adding pin verification rather than using `rejectUnauthorized: false`. A counterfeit Hub occupying the expected port must fail verification before it can obtain the credential. TLS supplies frame confidentiality and integrity; the registration credential authenticates the satellite. [Node TLS verification](https://nodejs.org/api/tls.html#tlscheckserveridentityhostname-cert)

Reject duplicate live window registrations and attempts to change the connection's registered window ID. Limit handshake time, message size and rate. Renew the local certificate and private trust/pin through an authenticated local operation; an unexpected pin change fails closed. A custom nonce/HMAC alternative would also need direction-bound integrity on every frame, so it is not the recommended first implementation.

Window IDs provide cooperative routing isolation, not cryptographic attestation of Electron window identity. A process with the user's registration credential can claim an ID. Both ends must reject tool routing outside the connection's registered window; an agent bearer token never doubles as a satellite credential.

Validate `Origin` and allowed Host values on unauthenticated local HTTP and WS upgrades; deny arbitrary web origins and `Origin: null`. Native clients normally omit Origin. Do not enable wildcard browser CORS on shell-control routes. MCP requires rejecting invalid present origins to prevent DNS rebinding. [MCP HTTP security](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

**Recommendation:** protect owner enrollment, consent and token management with their own session/CSRF checks even when the owner reaches them locally. Loopback HTTP proves location, not OS account identity: the requested token-free local-agent policy trusts local processes, including other OS users that can access that port. A shared-host deployment must opt into local tokens or user-restricted IPC; the satellite's registration credential cannot change this property of unauthenticated HTTP.

## Service installation and validation

Run the Hub as the Tabby user's ordinary account, supervised by the OS, with the same protocol on all platforms:

- Linux: systemd user unit in `~/.config/systemd/user`, restart on failure. [Unit locations](https://github.com/systemd/systemd/blob/main/man/systemd.unit.xml), [Restart semantics](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)
- macOS: per-user LaunchAgent with KeepAlive; run the Node process in the foreground under launchd rather than double-forking. A LaunchAgent normally ends at logout. [Apple launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- Windows: current-user scheduled task triggered at logon, configured for restart and unrestricted run duration; disable default battery-related stops if continuous operation is intended. The default Task Scheduler execution limit is 72 hours. [Logon trigger](https://learn.microsoft.com/en-us/windows/win32/taskschd/starting-an-executable-when-a-user-logs-on), [Task settings](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings)

**Recommendation:** installation/doctor must demonstrate: two simultaneous windows; satellite rejection on every network route; browser-origin rejection; local and direct-Tailnet MCP access without bearer; public/Funnel MCP 401 without bearer despite proxy loopback; OAuth metadata behind a prefix; successful PKCE approval; rejection of wrong audience/expired/revoked tokens; denial when Tailscale trust cannot be established; and stream closure after revocation. Preserve existing Serve/Funnel routes during these checks.

Client OAuth, custom-header, resource-subscription and protocol-version support vary. Test the intended phone/desktop agent clients before claiming compatibility. Neither the core specification nor the SDK proves any individual product supports every mechanism described here.
