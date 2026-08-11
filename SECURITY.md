# Security Policy

## Supported versions

Security fixes land on the latest published minor release. Older versions are
not patched — please upgrade before reporting.

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/dennytosp/eas-local-cache/security/advisories/new),
or by email to **phong.dinh2108@gmail.com**.

Please include:

- The affected version of `eas-local-cache`
- A description of the issue and its impact
- Steps to reproduce

### What to expect

- **Acknowledgement** within 5 working days.
- An assessment and a plan (fix, mitigation, or "not a vulnerability, and why")
  within 14 days.
- Credit in the release notes when the fix ships, unless you prefer otherwise.

## Scope

`eas-local-cache` is a development-time Expo CLI plugin. It runs on a
developer's machine or CI runner during `expo run:ios` / `expo run:android`,
reads and writes under `.expo/cache` in the project root, and shells out to
`ditto` or `cp` to copy build artifacts. It ships no runtime dependencies and
performs no network access.

Reports that are in scope include:

- Path traversal or writes outside the project's `.expo/cache` directory
- Command injection through fingerprint hashes, platform names, or build paths
- Cache poisoning: causing a build artifact to be reused for a configuration it
  was not built for
- Supply-chain issues with the published npm package or the release workflow

Vulnerabilities in Expo CLI, `@expo/config`, or the fingerprinting itself should
be reported to [Expo](https://github.com/expo/expo/security) directly.
