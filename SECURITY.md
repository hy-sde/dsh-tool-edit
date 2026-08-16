# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: security@hy-sde.dev (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- The `edit` tool writes files only through the harness filesystem contract
  (`ctx.fs`), which enforces the deployment's sandbox/observation policy when
  mounted; delete and move are confined to the session working directory.
- The embedded LSP client executes an external language server
  (`typescript-language-server` by default, invoked through `npx`) — treat
  `lspCommand` as a trust boundary: only pin servers you control.
- The plugin communicates with the language server exclusively over
  per-deployment stdio; no network listener is opened.
- Malicious workspace content (e.g. a `tsconfig.json` from untrusted code)
  can influence a language server's behavior; run agents in sandboxed
  environments when handling untrusted repositories.
