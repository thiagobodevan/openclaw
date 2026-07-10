#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: bash scripts/openclaw-npm-publish.sh (--validate package.tgz | --publish [package.tgz])"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

publish_mode="${1:-}"
case "${publish_mode}" in
  --publish | --validate) ;;
  *)
    usage >&2
    exit 2
    ;;
esac
shift

publish_target=""
if [[ "${1:-}" == "--" ]]; then
  shift
fi
if [[ "$#" -gt 0 ]]; then
  case "$1" in
    -*) echo "error: unexpected npm publish target option: $1" >&2; exit 2 ;;
    *) publish_target="$1"; shift ;;
  esac
fi
if [[ "$#" -gt 0 ]]; then
  echo "error: unexpected npm publish argument: $1" >&2
  exit 2
fi
if [[ "${publish_mode}" == "--validate" && -z "${publish_target}" ]]; then
  echo "error: npm publish validation requires a package tarball" >&2
  exit 2
fi

if [[ -n "${publish_target}" && -f "${publish_target}" ]]; then
  case "${publish_target}" in
    /*|./*|../*) ;;
    *) publish_target="./${publish_target}" ;;
  esac
fi

package_version="$(node -p "require('./package.json').version")"
if [[ -n "${publish_target}" ]]; then
  if [[ ! -f "${publish_target}" ]]; then
    echo "error: npm publish tarball not found: ${publish_target}" >&2
    exit 2
  fi
  expected_package_name="${OPENCLAW_NPM_EXPECTED_PACKAGE_NAME:-}"
  case "${expected_package_name}" in
    openclaw | @openclaw/ai) ;;
    *)
      echo "error: OPENCLAW_NPM_EXPECTED_PACKAGE_NAME must be openclaw or @openclaw/ai" >&2
      exit 2
      ;;
  esac
  if ! node "${script_dir}/openclaw-npm-publish-tarball.mjs" \
    "${publish_target}" "${expected_package_name}" "${package_version}"; then
    exit 2
  fi
fi

publish_plan="$(
  PACKAGE_VERSION="${package_version}" REQUESTED_PUBLISH_TAG="${OPENCLAW_NPM_PUBLISH_TAG:-}" \
    BYPASS_EXTENDED_STABLE_GUARD="${BYPASS_EXTENDED_STABLE_GUARD:-}" \
    node "${script_dir}/openclaw-npm-extended-stable-release.mjs" publish-plan
)"

release_channel="${publish_plan%%$'\n'*}"
publish_tag="${publish_plan#*$'\n'}"

echo "Resolved package version: ${package_version}"
echo "Resolved release channel: ${release_channel}"
echo "Resolved publish tag: ${publish_tag}"
if [[ -n "${publish_target}" ]]; then
  echo "Resolved publish target: ${publish_target}"
fi
if [[ "${publish_mode}" == "--validate" ]]; then
  echo "Validated npm publish target without mutation."
  exit 0
fi

publish_cmd=(npm publish)
if [[ -n "${publish_target}" ]]; then
  publish_cmd+=("${publish_target}")
fi
publish_cmd+=(
  --access public
  --tag "${publish_tag}"
  --provenance
  --registry=https://registry.npmjs.org/
  --@openclaw:registry=https://registry.npmjs.org/
)

echo "Publish auth: GitHub OIDC trusted publishing"

printf 'Publish command:'
printf ' %q' "${publish_cmd[@]}"
printf '\n'

"${publish_cmd[@]}"
