#!/bin/sh
set -eu
cd "$(dirname "$0")"
version=$(node -p 'require("../package.json").peerDependencies.convex.replace(/^\^/, "")')
rm -rf node_modules
mkdir -p node_modules/convex
tarball=$(npm pack "convex@$version" --silent --pack-destination node_modules)
tar -xzf "node_modules/$tarball" -C node_modules/convex --strip-components=1
node -p '"convex " + require("./node_modules/convex/package.json").version'
../node_modules/.bin/tsc -p .
