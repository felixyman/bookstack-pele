#!/usr/bin/env bash
#
# Build the distributable BookStack theme module ZIP.
#
# The module version in bookstack-module.json and PeleTheme::VERSION must
# match, otherwise cached renders and the module metadata would drift.
#
# Usage:   scripts/build-module-zip.sh
# Output:  dist/pele-diagrams-<version>.zip

set -euo pipefail

cd "$(dirname "$0")/.."

module_dir="pele-diagrams"
module_json="${module_dir}/bookstack-module.json"
dist_dir="dist"

module_version=$(python3 -c "import json; print(json.load(open('${module_json}'))['version'])")
theme_version=$(sed -n "s/.*public const VERSION = '\([^']*\)'.*/\1/p" "${module_dir}/PeleTheme.php")

if [ "${module_version}" != "${theme_version}" ]; then
    echo "Version mismatch: ${module_json} declares '${module_version}' but PeleTheme.php declares '${theme_version}'." >&2
    echo "Bump both together, then rebuild." >&2
    exit 1
fi

mkdir -p "${dist_dir}"
output="${dist_dir}/pele-diagrams-${module_version}.zip"
rm -f "${output}"

(cd "${module_dir}" && zip -qr "../${output}" . -x '.*')

echo "Built ${output}"
unzip -l "${output}"
