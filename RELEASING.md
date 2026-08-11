# Releasing

Releases are selected with pull request labels. Pull request titles and commit
messages do not determine the version.

## Release decisions

Choose exactly one release decision for every source pull request targeting
`main`:

| Decision | Pull request label | `1.2.3` becomes | Use for |
| --- | --- | --- | --- |
| Skip | No `release:*` label | Unchanged | Changes that must not publish a new npm version |
| Patch | `release:patch` | `1.2.4` | Backwards-compatible fixes and small internal changes |
| Minor | `release:minor` | `1.3.0` | Backwards-compatible provider behavior or options |
| Major | `release:major` | `2.0.0` | Breaking cache-provider contract or behavior changes |

Skip is the default. Publishing always requires an explicit release label.

Only one `release:*` label should be present. If conflicting labels are
accidentally applied, the highest version wins: major, then minor, then patch.

## One-time label setup

Run these commands once from the repository checkout. `--force` also repairs
the description or color if the label already exists.

```bash
gh auth status

gh label create "release:patch" \
  --color "0E8A16" \
  --description "Publish the next patch version after merge" \
  --force

gh label create "release:minor" \
  --color "1D76DB" \
  --description "Publish the next minor version after merge" \
  --force

gh label create "release:major" \
  --color "B60205" \
  --description "Publish the next major version after merge" \
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

```bash
gh pr edit "$PR_NUMBER" \
  --remove-label "release:minor,release:major" \
  --add-label "release:patch"
```

### Minor

```bash
gh pr edit "$PR_NUMBER" \
  --remove-label "release:patch,release:major" \
  --add-label "release:minor"
```

### Major

```bash
gh pr edit "$PR_NUMBER" \
  --remove-label "release:patch,release:minor" \
  --add-label "release:major"
```

### Skip

```bash
gh pr edit "$PR_NUMBER" \
  --remove-label "release:patch,release:minor,release:major"
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

- `[]` means no npm release.
- `["release:patch"]` means patch.
- `["release:minor"]` means minor.
- `["release:major"]` means major.
- More than one value is a conflict; apply one of the commands above again.

## What automation does

Source pull requests run format, lint, typecheck, test, build, and package
checks without changing `package.json` or `CHANGELOG.md`. GitHub requires the
CI checks to pass before the pull request can be merged into `main`.

After the merged `main` commit passes CI, the release workflow examines every
merged change since the latest `v*` tag. It uses the highest requested decision
— major, then minor, then patch — and commits the version and CHANGELOG update
directly to `main`. A stale CI run does nothing when a newer `main` commit is
already being verified.

The same workflow dispatches `release.yml` for that exact commit and waits for
it to finish. The release repeats the quality checks, publishes to npm with
provenance, tags `v<version>`, and creates the GitHub Release. There is no second
release pull request to merge. An already-published version is not published
twice, but missing tags or GitHub Releases are still repaired.

## Operational notes

- Pull requests without a release label are ignored when the next version is
  selected.
- Dependabot pull requests carry `release:patch`. Remove it when a dependency
  change must not publish.
- If the version on `main` differs from the latest `v*` tag, release
  preparation stops instead of bumping again. Repair the interrupted release
  with `gh workflow run release.yml`; if unreleased merged changes remain, run
  `gh workflow run bump.yml` afterward.
- npm publishing requires the configured trusted publisher for `release.yml`.
