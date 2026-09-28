#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build every recovery tool from this kit, with no network: age, zstd, and PostgreSQL (pg_restore,
# psql, a server to restore into) with the zlib it needs to read compressed dumps, plus m4, bison and
# flex, which building PostgreSQL needs. Everything lands in <prefix>/bin.
#
#   bash build-tools.sh <prefix>        then: export PATH="<prefix>/bin:$PATH"
#
# Needs a C compiler, make and Perl (macOS: `xcode-select --install`). Takes a few minutes, mostly
# PostgreSQL. Works on Linux and macOS; on Windows, run it under WSL. The kit itself is only read.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: bash build-tools.sh <prefix>" >&2; exit 2; }
KIT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$1"
PREFIX="$(cd "$1" && pwd)"
SRC="$PREFIX/src"
mkdir -p "$SRC" "$PREFIX/bin"
export PATH="$PREFIX/bin:$PATH"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"

# Each step's output goes to a log; on failure, show its tail.
step() {
  local name="$1"; shift
  printf '  %-12s' "$name"
  if ( "$@" ) >"$SRC/$name.log" 2>&1; then echo "ok"; else echo "FAILED"; tail -30 "$SRC/$name.log"; exit 1; fi
}
unpack() { tar xzf "$KIT/$1" -C "$SRC"; }
one() { local m=( $1 ); [ -e "${m[0]}" ] || { echo "not in the kit: $1" >&2; exit 1; }; echo "${m[0]}"; }
gnu() { # ./configure && make && make install, for m4, bison, flex and the like
  local dir="$SRC/$(basename "$1" .tar.gz)"
  unpack "$1" && cd "$dir" && ./configure --prefix="$PREFIX" && make -j"$JOBS" && make install
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) AGE=darwin-arm64 ;;
  Darwin-x86_64) AGE=darwin-amd64 ;;
  Linux-x86_64) AGE=linux-amd64 ;;
  Linux-aarch64 | Linux-arm64) AGE=linux-arm64 ;;
  *) echo "no age binary in the kit for $(uname -s) $(uname -m); build age/age-*-source.tar.gz with Go" >&2; exit 1 ;;
esac

cd "$KIT"
AGE_TGZ="$(one "age/age-v*-$AGE.tar.gz")"
ZSTD_TGZ="$(one "zstd/zstd-*.tar.gz")"
M4_TGZ="$(one "postgres/m4-*.tar.gz")"
BISON_TGZ="$(one "postgres/bison-*.tar.gz")"
FLEX_TGZ="$(one "postgres/flex-*.tar.gz")"
ZLIB_TGZ="$(one "postgres/zlib-*.tar.gz")"
PG_TGZ="$(one "postgres/postgresql-*.tar.gz")"

echo "Building the recovery tools into $PREFIX (logs in $SRC):"
step age   bash -c "tar xzf '$KIT/$AGE_TGZ' -C '$SRC' && cp '$SRC/age/age' '$SRC/age/age-keygen' '$PREFIX/bin/'"
# zstd alone: without the HAVE_* switches its Makefile links any lzma/lz4/zlib it happens to find.
step zstd  bash -c "tar xzf '$KIT/$ZSTD_TGZ' -C '$SRC' && make -j$JOBS -C '$SRC/$(basename "$ZSTD_TGZ" .tar.gz)' zstd HAVE_LZMA=0 HAVE_LZ4=0 HAVE_ZLIB=0 && cp '$SRC/$(basename "$ZSTD_TGZ" .tar.gz)/programs/zstd' '$PREFIX/bin/'"
step m4    gnu "$M4_TGZ"
step bison gnu "$BISON_TGZ"
step flex  gnu "$FLEX_TGZ"
# Static, so pg_restore carries zlib inside it rather than looking for a libz at run time.
step zlib  bash -c "tar xzf '$KIT/$ZLIB_TGZ' -C '$SRC' && cd '$SRC/$(basename "$ZLIB_TGZ" .tar.gz)' && ./configure --static --prefix='$PREFIX/zlib' && make install"
step postgres bash -c "tar xzf '$KIT/$PG_TGZ' -C '$SRC' && cd '$SRC/$(basename "$PG_TGZ" .tar.gz)' && \
  ./configure --prefix='$PREFIX' --without-icu --without-readline \
    --with-includes='$PREFIX/zlib/include' --with-libraries='$PREFIX/zlib/lib' && \
  make -j$JOBS && make install"

echo "Done: $(age --version 2>/dev/null || echo age), $(zstd --version | sed 's/^\*\*\* //; s/ \*\*\*$//'), $(pg_restore --version)"
echo "Now: export PATH=\"$PREFIX/bin:\$PATH\""
