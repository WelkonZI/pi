#!/usr/bin/env bash
set -euo pipefail

repository="$1"
release_tag="$2"
source_commit="$3"
remote_url="$4"

release_count="$(
  gh api --paginate "repos/${repository}/releases?per_page=100" --jq '.[]' |
    jq -cs --arg tag "${release_tag}" '[.[] | select(.tag_name == $tag)] | length'
)"
if [[ "${release_count}" != "0" ]]; then
  echo "Release ${release_tag} already exists." >&2
  exit 1
fi

remote_tag_sha="$(git ls-remote --refs "${remote_url}" "refs/tags/${release_tag}" | awk '{print $1}')"
if [[ -n "${remote_tag_sha}" && "${remote_tag_sha}" != "${source_commit}" ]]; then
  echo "Tag ${release_tag} points to ${remote_tag_sha}, expected ${source_commit}." >&2
  exit 1
fi

printf '%s\n' "${remote_tag_sha}"
