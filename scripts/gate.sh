#!/usr/bin/env bash
# The gate: every check CI runs, in sequence, as one command (CONTRIBUTING.md). A commit is
# made only after this has exited 0 on the exact tree being committed. `set -e` stops at
# the first failure and `pipefail` makes a failing pipeline count.
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTFLAGS="-D warnings" RUSTDOCFLAGS="-D warnings"
pnpm typecheck
pnpm lint
pnpm test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo doc --workspace --no-deps
echo "gate: green"
