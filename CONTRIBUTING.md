# Developing guide

## Running locally

```sh
npm run setup
npm run dev
```

## Testing

```sh
npm run build
npm run check
npm run test:e2e
```

When component APIs change, regenerate and commit the generated files:

```sh
npm run build:codegen
```

## Releases

Include a changeset with changes that need a release:

```sh
npx changeset
```

Choose the version bump, describe the user-visible change, and commit the
generated file with your implementation. Docs-only and development-tooling
changes do not need a changeset.

Once your PR is open, add its number in parentheses at the end of the first
paragraph of each changeset, for example `(#279)`.

Review and merge the release PR when ready. Click **Approve workflows to run**
on the PR if its checks are waiting for approval. To refresh it manually, run
the [Update release PR workflow](./.github/workflows/version.yml) on main.

When the release PR merges, CI tags the commit that set the new version as
`v<version>` and starts the [Release workflow](./.github/workflows/release.yml)
on that tag. To release a different commit, tag it yourself:

```sh
gh api repos/convex/agent/git/refs -f ref=refs/tags/v1.2.3 -f sha=<commit>
```

Or, from a local clone: `git tag v1.2.3 <commit> && git push origin v1.2.3`.

The tag must match `package.json`'s version. Stable releases must be on `main`;
the commit may be older than the current tip. GitHub runs the release workflow
from the tagged commit, so the commit must include it. The workflow builds and
tests that commit, then stages the tested package on npm.

Review the package on npm's **Staged Packages** page and approve with 2FA, or
run:

```sh
npm stage approve <stage-id>
```

Use the stage ID from the workflow log. Approve versions in order to avoid
moving `latest` backward.

### Local preparation and prereleases

To prepare a release locally instead of using the bot:

```sh
npm ci
npm run build
npm run check
npx changeset version
```

Review and commit the version, changelog, and consumed changesets, then merge
through a checked PR.

For a branch prerelease, prepare a prerelease version with Changesets on that
branch and tag its commit, such as `v1.2.3-alpha.0`. The first prerelease
identifier selects the npm channel, such as `alpha`.

### Playground releases

`@convex-dev/agent-playground` has its own version and is ignored by the root
Changesets flow. The automated version PR applies only to `@convex-dev/agent`.
To release the playground, do not add a Changeset. Prepare a PR that updates
`playground/package.json` and the root `package-lock.json`, then merge it after
CI passes. For example, from the repo root:

```sh
npm version patch --workspace playground --no-git-tag-version
```

Check the resulting version and lockfile, then run **Release Playground** on
`main` with the 40-character SHA of the merge commit on `main`. The workflow
builds and checks both packages, stages the playground tarball on npm, and tags
the source as `playground/v<version>` after staging succeeds. Review and approve
the staged playground package on npm with 2FA before it becomes public. The
Agent version at that commit must already be published, with no Agent package
changes since its source tag. Release Agent first if needed.

Register the playground's own npm trusted publisher before its first release:

```sh
npm trust github @convex-dev/agent-playground --repo convex/agent --file release-playground.yml --allow-stage-publish
```

This npm package is separate from the hosted playground, which deploys through
`deploy.yml`.

### Recovery

The tag records intent to release; npm is the source of truth for what was
staged. If the workflow fails, check npm's staged packages first:

- Tagged, but Release didn't start: start it on the tag with
  `gh workflow run release.yml -R convex/agent --ref v1.2.3`.
- Not staged: rerun the failed jobs
  (`gh run rerun <run-id> -R convex/agent --failed`), for example after pushing
  `main` if the tag went first. A rerun uses the run's original commit and works
  for 30 days.

  To release a different commit, fix the source and move the tag:

  ```sh
  gh api -X PATCH repos/convex/agent/git/refs/tags/v1.2.3 -f sha=<commit> -F force=true
  ```

- Staged, but rejected in review: `npm stage reject <stage-id>` frees the
  version, so you can move the tag to a corrected commit. A published version
  cannot be reused; prepare a new version instead.
