# WelkonZI fork releases

This fork publishes `@earendil-works/pi-coding-agent` as a GitHub Release tarball. It does not publish fork packages to npm.

## Fork boundary

Personal runtime behavior is limited to `packages/coding-agent`; `packages/agent` remains upstream-compatible. The fork exposes a [trusted mutation interceptor](mutation-interceptor.md) for stable system/tool provenance. Pi provides live interception and factual observations only. An external consumer owns snapshots, validation, journaling, diffs, attribution policy, and completeness decisions.

## Create a release

The [**Personal Release** workflow](../../../.github/workflows/personal-release.yml) checks for official stable releases every 48 hours at 06:17 UTC, on even-numbered UTC days counted from the Unix epoch. A daily trigger exits before checkout on the intervening days, avoiding the month-boundary resets of a day-of-month `*/2` cron. Manual runs from the `personal` default branch bypass this interval.

GitHub Actions can delay or drop scheduled runs. Public repositories' schedules are disabled after 60 days without repository activity. This schedule publishes fork releases; it does not update a locally installed Pi.

The workflow:

1. finds the latest stable `earendil-works/pi` release;
2. derives the personal patch boundary from Git history, rebases onto that tag, and stops on conflicts;
3. rejects personal package changes outside `packages/coding-agent`;
4. runs checks, focused updater tests, and the production build;
5. assigns `<upstream-version>-welkonzi.<revision>`;
6. temporarily stamps and packs only the coding-agent tarball;
7. installs the tarball in an isolated prefix and verifies `pi --version`;
8. updates `personal` with lease protection;
9. publishes a normal GitHub Release containing the tarball and `latest.json`.

The temporary version stamp exists only in the tarball. The release tag points to the verified source commit, whose `packages/coding-agent/package.json` keeps the upstream version.

If transfer, checks, build, packaging, smoke installation, or the lease-protected branch update fails, no release is published. A conflict must be resolved manually. A retry after a successful branch update reuses the transferred candidate without replaying upstream commits. It may reuse a retained same-source orphan tag only after confirming that no draft or published release uses it. Failed publication cleanup removes only the exact draft release ID owned by that workflow run; remote tags, foreign releases, and uncertain state are preserved, so the previous normal release remains the `latest` release.

## Notifications

Use GitHub **Settings → Notifications → System → Actions** to enable email and/or on-site workflow notifications. **Only notify for failed workflows** limits these to failures such as a rebase conflict or failed check. Scheduled-run notifications go to the user who last changed the cron syntax, subject to those notification settings.

Subscribe separately to **Watch → Custom → Releases** on `WelkonZI/pi` for published-release notifications. No external notification service is configured. See [GitHub Actions notification settings](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).

## Install and update

Install the first fork release once from its GitHub Release tarball:

```sh
npm install -g --ignore-scripts "https://github.com/WelkonZI/pi/releases/download/<tag>/pi-coding-agent-<version>.tgz"
```

After the tracked agent settings are deployed, update normally:

```sh
pi update
```

Use `pi update --force` to reinstall the current fork release. The updater accepts only the canonical `WelkonZI/pi` HTTPS tarball URL from `latest.json`; it never falls back to the official npm package or managed installer. A malformed or unavailable manifest stops before installation. Every install path verifies the PATH-resolved `pi --version` and fails on a mismatch. A managed installation without `selfUpdateCommand` fails closed. The global package replacement does not modify `~/.pi/agent`, so settings, extensions, sessions, and credentials remain in place.
