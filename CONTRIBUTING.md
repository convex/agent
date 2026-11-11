# Developing guide

## Running locally

```sh
npm ci
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

Review and merge the release PR when ready. Click **Approve workflows to run**
on the PR if its checks are waiting for approval. To refresh it manually, run
the [Update release PR workflow](./.github/workflows/version.yml) on main.

After staging, review the package on npm's **Staged Packages** page and approve
with 2FA, or run:

```sh
npm stage approve <stage-id>
```

Use the stage ID from the workflow log. Approve versions in order to avoid
moving `latest` backward.

### Playground releases

`@convex-dev/agent-playground` has its own version. Changesets and the
automated version PR apply only to `@convex-dev/agent`. To release the
playground, do not add a Changeset. Prepare a PR that updates
`playground/package.json` and the root
`package-lock.json`, then merge it after CI passes. For example, from the repo
root:

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

### Local preparation and prereleases

To prepare a release locally instead of using the bot:

```sh
npm ci
npm run build
npm run check
npx changeset version
```

Review and commit the version, changelog, and consumed changesets, then merge
through a checked PR. A push to main stages the latest version-bump commit in
that push.

For a branch prerelease, prepare a prerelease version with Changesets and
dispatch **Release** from the Actions page on that branch. The first prerelease
identifier selects the npm channel, such as `alpha`. Stable releases require
main.

### Recovery

If staging has not been attempted, dispatch **Release** on the appropriate ref
with the 40-character SHA of a version-bump commit reachable from that ref. Once
staging starts, inspect npm before retrying: dispatching **Release** runs
`npm stage publish` again. If the package is already staged, retry only the
failed tag job or, after verifying the staged version, create its source tag at
the version-bump commit.

| Failure                                         | Recovery                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Failure before staging was attempted            | Retry failed jobs for the same commit.                                           |
| Staging succeeded; tagging failed               | Retry only the failed tag job, or create the source tag after verifying staging. |
| Upload outcome uncertain                        | Inspect npm; retry staging only if absent, or recover the tag if already staged. |
| Fix requires changing the release commit's code | Prepare a new version-bump commit.                                               |
| Candidate rejected after staging                | Leave its tag and prepare a new version.                                         |
