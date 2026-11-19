#!/usr/bin/env bash
set -euo pipefail

repository="$1"
release_tag="$2"
source_commit="$3"
fork_version="$4"
upstream_tag="$5"
release_marker="$6"
assets_dir="$7"
release_id=""

cleanup_release() {
  bash .github/scripts/cleanup-personal-release.sh \
    "${repository}" \
    "${release_id}" \
    "${release_tag}" \
    "${release_marker}"
}
trap cleanup_release EXIT

release_json="$(
  jq -n \
    --arg tag "${release_tag}" \
    --arg source "${source_commit}" \
    --arg name "Pi ${fork_version}" \
    --arg body $'Based on upstream '"${upstream_tag}"$'.\n\n<!-- '"${release_marker}"$' -->' \
    '{tag_name: $tag, target_commitish: $source, name: $name, body: $body, draft: true, prerelease: false}' |
    gh api --method POST "repos/${repository}/releases" --input -
)"
release_id="$(jq -er '.id' <<<"${release_json}")"

for asset_name in latest.json "pi-coding-agent-${fork_version}.tgz"; do
  curl \
    --fail-with-body \
    --silent \
    --show-error \
    -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Content-Type: application/octet-stream" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    --data-binary "@${assets_dir}/${asset_name}" \
    "https://uploads.github.com/repos/${repository}/releases/${release_id}/assets?name=${asset_name}" >/dev/null
done

asset_names="$(
  gh api --paginate "repos/${repository}/releases/${release_id}/assets?per_page=100" --jq '.[].name'
)"
for asset_name in latest.json "pi-coding-agent-${fork_version}.tgz"; do
  if ! grep -Fxq "${asset_name}" <<<"${asset_names}"; then
    echo "Release ${release_tag} is missing ${asset_name}." >&2
    exit 1
  fi
done

jq -n '{draft: false, prerelease: false, make_latest: "true"}' |
  gh api --method PATCH "repos/${repository}/releases/${release_id}" --input - >/dev/null

trap - EXIT
