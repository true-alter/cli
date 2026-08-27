# Security Policy

## Reporting a vulnerability

Email **security@truealter.com** with:

- A description of the issue and the CLI surface it affects (`alter login`, `alter creds`, `alter brief`, etc.).
- Reproduction steps, ideally a minimal command sequence.
- Your assessment of impact - local-only footgun, credential-exfiltration class, OAuth flow issue, anything in between.

We aim to acknowledge within 3 business days and agree a disclosure window with you before any public fix lands. PGP-encrypted reports welcome at the same address - keys on request.

Please do **not** open public GitHub issues for vulnerabilities.

## Scope

`@truealter/cli` is a local Node.js CLI. In-scope concerns for this repository:

- **OAuth 2.1 PKCE flow** (`src/commands/login.ts`) - code verifier/challenge generation, `state` validation, localhost callback server binding, the HTML pages rendered in the user's browser.
- **Credential handling** (`src/auth.ts`) - `~/.config/alter/session.json`, `identity.json`, file-mode on write, `alter logout` revocation and unlink behaviour.
- **Supply chain** - the published `dist/` output, the `publish.yml` npm publish workflow (OIDC Trusted Publisher, `id-token: write`), and direct dependencies.
- **Subprocess invocation** - browser launch, MCP server spawn in `alter brief`.

Out-of-scope:

- Vulnerabilities in the live ~alter API or MCP servers - report via the same address; they will be routed internally.
- Vulnerabilities in direct dependencies (`@clack/prompts`, `chalk`) - please report upstream as well.

## Coordinated disclosure

For issues that span this CLI and the live ~alter API, we will coordinate timing internally and agree a combined disclosure window with you. We prefer agreed disclosure windows over embargoed surprise drops.

## Supported versions

The latest `0.x` release on npm receives security fixes. Older `0.x` releases are not patched - please upgrade.

Once `1.0.0` ships, the supported-version policy will expand to cover at least the most recent minor.
