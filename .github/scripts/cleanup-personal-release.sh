#!/usr/bin/env bash
set -euo pipefail

main() {
  local repository="$1"
  local release_id="$2"
  local release_tag="$3"
  local release_marker="$4"
  local release_json recovered_ids

  if [[ -z "${release_id}" ]]; then
    if ! recovered_ids="$(
      gh api --paginate "repos/${repository}/releases?per_page=100" --jq '.[]' |
        jq -csr --arg tag "${release_tag}" --arg marker "${release_marker}" \
          '[.[] | select(.tag_name == $tag and .draft == true and ((.body // "") | contains($marker))) | .id] | .[]'
    )"; then
      return 0
    fi
    if [[ -z "${recovered_ids}" || "${recovered_ids}" == *$'\n'* ]]; then
      return 0
    fi
    release_id="${recovered_ids}"
  fi

  if ! release_json="$(gh api "repos/${repository}/releases/${release_id}")"; then
    return 0
  fi
  if ! jq -e --arg marker "${release_marker}" '.draft == true and ((.body // "") | contains($marker))' \
    <<<"${release_json}" >/dev/null; then
    return 0
  fi
  gh api --method DELETE "repos/${repository}/releases/${release_id}" >/dev/null || true
}

main "$@"
