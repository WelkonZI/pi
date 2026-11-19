#!/usr/bin/env bash
set -euo pipefail

candidate_ref="$1"
upstream_main_ref="$2"
target_ref="$3"
target_label="${4:-$3}"

git switch --force-create release-candidate "${candidate_ref}"
if ! git merge-base --is-ancestor "${target_ref}" "${upstream_main_ref}"; then
  echo "::error::${target_label} is not an ancestor of upstream main."
  exit 1
fi
patch_base="$(git merge-base HEAD "${upstream_main_ref}")"
if [[ "${patch_base}" == "$(git rev-parse "${target_ref}^{commit}")" ]]; then
  exit 0
fi
if ! git rebase --onto "${target_ref}" "${patch_base}"; then
  conflicts="$(git diff --name-only --diff-filter=U | paste -sd ', ' -)"
  git rebase --abort
  echo "::error::Personal patches conflict with ${target_label}: ${conflicts:-unknown files}"
  exit 1
fi
