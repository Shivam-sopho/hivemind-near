#!/usr/bin/env bash
# Build both contracts to optimized WASM (requires cargo-near: `cargo install cargo-near`).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p res
for c in honey hive; do
  (cd contracts/$c && cargo near build non-reproducible-wasm --no-abi >/dev/null)
  cp target/near/$c/$c.wasm res/$c.wasm
done
ls -la res
