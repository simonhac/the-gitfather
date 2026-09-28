#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The OFFLINE RECOVERY DRILL, run inside a container with no network by
# `npm run key-shares -- drill --kit <dir>` (see docs/key-escrow.md#proving-the-kit-offline).
#
# It follows the kit's README step by step, using nothing but the kit (read-only at /kit) and a
# practice issue (read-only at /drill): two holders' shares of two throwaway keys, the public
# recipients those keys must derive, and a zstd+age archive file made outside the container. If a
# step needs something the kit lacks, the drill fails, and that is the point of it.
#
# The one thing made in here is the practice dump: the host's pg_dump may be a newer major than the
# kit's, and a dump from a newer pg_dump will not restore. So the kit's own PostgreSQL dumps a small
# database and encrypts it to the practice recipient (public key only) before any key is rebuilt.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

step() { printf '\n── %s\n' "$*"; }
ok() { printf '✓ %s\n' "$*"; }
die() { printf '✕ %s\n' "$*"; exit 1; }
quiet() { "$@" >"$WORK/last.log" 2>&1 || { tail -40 "$WORK/last.log"; die "$1 failed"; }; }

WORK="$HOME/work"
mkdir -p "$WORK"
SENTINEL="$(cat /drill/sentinel.txt)"

step "No network"
if python3 -c "import socket; socket.create_connection(('1.1.1.1', 443), 3)" 2>/dev/null; then
  die "the container can reach the internet, so this drill would prove nothing"
fi
ok "the container is offline"

step "0. Check the kit"
cp -R /kit "$WORK/kit"
cd "$WORK/kit"
sha256sum --quiet -c SHA256SUMS || die "the kit does not match its SHA256SUMS"
ok "every file matches SHA256SUMS"

step "2. Rebuild each key from two cards"
python3 -m venv "$WORK/slip39"
quiet "$WORK/slip39/bin/pip" install --no-index --find-links python 'shamir-mnemonic[cli]' bech32
"$WORK/slip39/bin/python" -c "
from shamir_mnemonic.wordlist import WORDLIST
assert WORDLIST == open('slip39/wordlist.txt').read().split(), 'the library word list differs from the spec'
" || die "word list mismatch"
ok "installed shamir-mnemonic and bech32 from the kit; its word list is the spec's"
for key in dump archive; do
  hex="$("$WORK/slip39/bin/shamir" recover <"/drill/shares-$key.txt" | sed -n 's/^Your master secret is: //p')"
  [ -n "$hex" ] || die "shamir recover did not rebuild the $key key"
  "$WORK/slip39/bin/python" -c "import bech32,sys; print(bech32.bech32_encode('age-secret-key-', \
    bech32.convertbits(bytes.fromhex(sys.argv[1]), 8, 5)).upper())" "$hex" >"$WORK/$key-identity.txt"
  ok "rebuilt the $key key from shares $(cat "/drill/holders-$key.txt")"
done

step "3–5. Build age, zstd and PostgreSQL from the kit (a few minutes)"
bash build-tools.sh "$HOME/tools"
export PATH="$HOME/tools/bin:$PATH"

step "3. age"
for key in dump archive; do
  derived="$(age-keygen -y "$WORK/$key-identity.txt")"
  [ "$derived" = "$(cat "/drill/recipient-$key.txt")" ] || die "the $key key derives $derived, not the practice recipient"
done
ok "$(age --version): both rebuilt keys derive their recipients"

step "4. zstd"
age -d -i "$WORK/archive-identity.txt" /drill/drill-archive.ndjson.zst.age | zstd -d >"$WORK/rows.ndjson"
grep -qF "$SENTINEL" "$WORK/rows.ndjson" || die "the archive file decrypted but its rows are not the practice rows"
ok "decrypted and decompressed the practice archive"

step "5. pg_restore"
quiet initdb -D "$HOME/pgdata" -U postgres
quiet pg_ctl -D "$HOME/pgdata" -l "$WORK/pg.log" -w start
ok "$(pg_restore --version), built with the kit's zlib"

# The practice dump: -Fc with its default (zlib) compression, like a real backup, encrypted to the
# dump recipient. The plaintext is deleted before recovery starts.
createdb -U postgres practice
psql -U postgres -d practice -qc "CREATE TABLE drill (note text); INSERT INTO drill VALUES ('$SENTINEL');"
pg_dump -U postgres -Fc --no-owner --no-privileges practice >"$WORK/plain.dump"
age -r "$(cat /drill/recipient-dump.txt)" -o "$WORK/practice.dump.age" "$WORK/plain.dump"
rm "$WORK/plain.dump"
dropdb -U postgres practice

age -d -i "$WORK/dump-identity.txt" "$WORK/practice.dump.age" >"$WORK/backup.dump"
createdb -U postgres restored
pg_restore -U postgres -d restored --no-owner --no-privileges "$WORK/backup.dump"
got="$(psql -U postgres -d restored -tAc 'SELECT note FROM drill')"
[ "$got" = "$SENTINEL" ] || die "the restored table says '$got'"
ok "decrypted a compressed dump with the rebuilt key and restored it"
pg_ctl -D "$HOME/pgdata" -m fast stop >/dev/null

printf '\n✓ OFFLINE DRILL PASSED: the kit alone rebuilt both keys, opened an archive and restored a dump.\n'
