# Releasing PALUGADA

A release is a version an operator can name, install again and roll back
to: a tag, an image built from it, and notes that say what it holds. This is
how one is cut, and how main is kept green between them.

## What a version is

Three things that always agree, and `test/documents/release.test.ts` fails
the suite when they do not:

- **`package.json`'s `version`** (and the two places `package-lock.json`
  repeats it). It is what a running deployment reports: `/api/health`,
  `palugada_build_info` in the metrics, the foot of the owner's menu.
- **The newest section of `CHANGELOG.md`**, `## 0.2.0 (not yet released)`
  while it is being written, and `## 0.2.0 (2026-11-02)` once it is
  released. Only the newest section may be unreleased, and the sections run
  newest first.
- **The tag**, `v0.2.0`, made on main once the version's commit is there.

The numbers are [SemVer](https://semver.org/). Before 1.0 the second number
moves for anything an operator must act on -- a setting that changed
meaning, a step in the upgrade -- and the third for everything else.
Migrations never decide the number: they are append-only and run by
themselves (`npm run db:migrate`, or the image's own start), so any release
upgrades any earlier database.

## Cutting a release

From a clean checkout of main, with the version's CHANGELOG section saying
everything it holds:

```sh
git switch -c release-0.2.0 origin/main
node scripts/release.ts prepare 0.2.0
```

`prepare` dates the unreleased section as `0.2.0` today (`--date YYYY-MM-DD`
for another day), sets `package.json` and the lockfile to it, and commits
`Release 0.2.0`. It refuses a working tree with changes in it, a version that
is not three numbers or not after the last release, and a CHANGELOG with
nothing unreleased. Push the branch and merge it the way every change
reaches main.

Then, on main with that commit in it:

```sh
git switch main && git pull
node scripts/release.ts tag 0.2.0
git push origin v0.2.0
```

`tag` refuses unless the tree is clean and the commit checked out agrees
with the version, and makes an annotated tag. It is a separate step because
a pull request merged through a queue lands as a new commit: a tag made on
the branch would name a commit main never held, and the release workflow
refuses those.

Pushing the tag starts `.github/workflows/release.yml`:

1. **agree**: `node scripts/release.ts check v0.2.0` -- the tag,
   `package.json`, the lockfile and a dated CHANGELOG section name one
   version -- and the tagged commit is on main.
2. **ci**: the whole of `.github/workflows/ci.yml` on the tagged commit: the
   suite against PostgreSQL, the dependency audit, and the image run with
   Docker Compose.
3. **publish**: the image built from the `Dockerfile`, pushed to
   `ghcr.io/<owner>/palugada:0.2.0` and `:latest`, and a GitHub release
   named `PALUGADA 0.2.0` whose notes are that CHANGELOG section
   (`node scripts/release.ts notes 0.2.0`).

Nothing is published unless the first two pass. A release that failed is
fixed with a new version; a tag that was pushed is not moved.

### Opening the next version

The first change after a release that needs a CHANGELOG line opens the
next section above the released one, and moves the version with it:

```sh
npm version 0.3.0 --no-git-tag-version
```

which changes `package.json` and the lockfile and nothing else; add
`## 0.3.0 (not yet released)` to `CHANGELOG.md` in the same commit. Until
then the suite holds the released version and its section together.

## The image

The first push makes the package `ghcr.io/<owner>/palugada` private. To let
anyone pull it, open the package on GitHub (the repository's **Packages**),
**Package settings**, and change its visibility to public, once.

```sh
docker pull ghcr.io/tegarthegreat/palugada:0.2.0
```

runs anywhere an image does ([Coolify and Dokploy](guide/coolify-dokploy.md),
[running the image by itself](guide/operations.md#running-the-image-by-itself)).
The image is built from the tag and only after CI passed on it.

## Installing a release

The one-command installer takes a release's tag:

```sh
curl -fsSL https://raw.githubusercontent.com/TegarTheGreat/PALUGADA/main/install.sh | PALUGADA_VERSION=v0.2.0 sh
```

The variable is given to `sh`, not to `curl`, since `sh` is what reads it.
Run again with the next version, it updates to that one; without
`PALUGADA_VERSION`, it installs and updates from main. Run with an earlier
version, it goes back to it: the platform starts on a database a later
version migrated, since migrations only add, and the copy the installer
took before each update (`~/palugada/backups`) is there when it is the data
that needs to go back too.

## The merge queue

Two pull requests that each passed against an older main can still break it
together. A merge queue tests each one on top of what main is about to
become, with the ones ahead of it in the queue, and merges only what passed.
CI's half is in `.github/workflows/ci.yml` (`merge_group`); the other half
is the repository's settings, once, by someone who administers it:

1. **Settings**, **Rules**, **Rulesets**: a branch ruleset for `main` (or
   **Branches**, a branch protection rule, on a plan without rulesets).
2. **Require a pull request before merging.**
3. **Require status checks to pass**, with `test`, `audit` and `docker` --
   CI's three jobs.
4. **Require merge queue**, merging with a merge commit, so the commits the
   suite passed are the commits main holds.

Pull requests then go to main with **Merge when ready**. A push straight to
main is refused, which is why a release's commit is a pull request too.
