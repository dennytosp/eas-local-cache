# Releasing

Releases are selected with pull request labels. Pull request titles and commit
messages do not determine the version.

## Release decisions

Choose exactly one release decision for every source pull request targeting
`main`:

| Decision | Pull request label | `1.2.3` becomes | Use for |
| --- | --- | --- | --- |
| Patch | No `release:*` label | `1.2.4` | Backwards-compatible fixes and small internal changes |
| Minor | `release:minor` | `1.3.0` | Backwards-compatible provider behavior or options |
| Major | `release:major` | `2.0.0` | Breaking cache-provider contract or behavior changes |
| Skip | `release:skip` | Unchanged | Changes that must not publish a new npm version |

Patch is the default. There is intentionally no `release:patch` label.

Only one `release:*` label should be present. `release:skip` excludes the
merged pull request from the next release, and `release:major` takes precedence
over `release:minor` if conflicting labels are accidentally applied.

## One-time label setup

Run these commands once from the repository checkout. `--force` also repairs
the description or color if the label already exists.

```bash
gh auth status

gh label create "release:minor" \
  --color "1D76DB" \
  --description "Publish the next minor version after merge" \
  --force

gh label create "release:major" \
  --color "B60205" \
  --description "Publish the next major version after merge" \
  --force

gh label create "release:skip" \
  --color "6A737D" \
  --description "Do not publish a new npm version after merge" \
  --force
```

If `gh auth status` reports an expired or missing login, run `gh auth login`
before creating or editing labels.

## Apply a decision to a pull request

Set the pull request number once:

```bash
PR_NUMBER=123
```

### Patch

Patch is represented by removing every release label:

```bash
gh pr edit "$PR_NUMBER" \
  --remove-label "release:minor,release:major,release:skip"
```

### Minor

```bash
gh pr edit "$PR_NUMBER" \
  --remove-label "release:major,release:skip" \
  --add-label "release:minor"
```

### Major

```bash
gh pr edit "$PR_NUMBER" \
  --remove-label "release:minor,release:skip" \
  --add-label "release:major"
```

### Skip

```bash
gh pr edit "$PR_NUMBER" \
  --remove-label "release:minor,release:major" \
  --add-label "release:skip"
```

You can use a pull request URL or branch name instead of its number. When the
current branch already has a pull request, `gh pr edit` also works without an
argument.

## Verify the decision

List only the release labels currently applied to the pull request:

```bash
gh pr view "$PR_NUMBER" \
  --json labels \
  --jq '[.labels[].name | select(startswith("release:"))]'
```

Interpret the output as follows:

- `[]` means patch.
- `["release:minor"]` means minor.
- `["release:major"]` means major.
- `["release:skip"]` means no npm release.
- More than one value is a conflict; apply one of the commands above again.

## What automation does

Source pull requests run CI without changing `package.json` or `CHANGELOG.md`.
The release decision is read only after a pull request has been merged into
`main`.

After a non-skipped merge, the Prepare release workflow examines every merged
change since the latest `v*` tag. It uses the highest requested decision —
major, then minor, then patch — and creates or refreshes a single
`release/next` pull request from the latest `main`. That release pull request
contains the version and CHANGELOG commit and carries `release:skip` so it
cannot recursively prepare another release.

The workflow dispatches CI explicitly on `release/next`. After those checks
pass, merge the release pull request. Its merge is the first time the new
version appears on `main`.

The Release workflow then verifies the code, publishes to npm with provenance,
tags `v<version>`, and creates the GitHub Release. An already-published version
is skipped successfully.

## Operational notes

- `release:skip` pull requests are ignored when the next version is selected.
- Dependency updates use patch by default. Add `release:skip` manually when a
  dependency change must not publish.
- This repository currently requires a maintainer to merge `release/next`
  after CI passes; repository auto-merge is disabled.
- If the version on `main` differs from the latest `v*` tag, release
  preparation stops instead of skipping over an incomplete publication.
- npm publishing requires the configured trusted publisher or an `NPM_TOKEN`
  repository secret.
