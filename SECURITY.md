# Security Policy

## Supported Versions

Security fixes are provided for the latest stable release (see
[Releases](https://github.com/SunMe1977/DiskRaptor/releases)). Older
versions may not receive fixes — please update first.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

- Prefer **GitHub Security Advisories** (private report) on this repository, or
- email [info@diskraptor.com](mailto:info@diskraptor.com) with:
  - the affected version and platform (Windows / macOS / Linux),
  - steps to reproduce or a proof of concept,
  - the potential impact as you see it.

We aim to confirm receipt within 72 hours and will keep you updated while
we investigate. Please allow reasonable time for a fix before any public
disclosure.

## Scope Notes

DiskRaptor scans **100% locally** — there is no cloud backend, no account
system and no telemetry. Most security-relevant surface is therefore local
file handling (path parsing, archive/HTML report export, installer
permissions). Reports about the update check (`check_for_updates`, GitHub
Releases API over HTTPS) are also welcome.
