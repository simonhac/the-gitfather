import { test } from "node:test";
import assert from "node:assert/strict";
import { countTocTableEntries } from "../backup-pg-to-r2.js";

// `pg_restore -l` exits 0 on a schema-only dump, and a schema-only dump of a real database is
// comfortably over dump.min-bytes. Counting TABLE entries is the only thing between "this archive
// parses" and "this archive contains data", and it now runs on every backup rather than only the
// unencrypted ones — so it is worth more than an untested one-liner inside a closure.

const REAL_TOC = `;
; Archive created at 2026-09-25 16:03:06 UTC
;     dbname: postgres
;
;
; Selected TOC Entries:
;
215; 1259 16385 TABLE public people postgres
3401; 0 16385 TABLE DATA public people postgres
216; 1259 16392 TABLE public organisations postgres
3402; 0 16392 TABLE DATA public organisations postgres
3410; 2606 16400 CONSTRAINT public people people_pkey postgres
`;

test("countTocTableEntries counts TABLE and TABLE DATA lines, ignoring other entry types", () => {
  assert.equal(countTocTableEntries(REAL_TOC), 4, "2 TABLE + 2 TABLE DATA; CONSTRAINT is not one");
});

test("countTocTableEntries returns 0 for a schema-only dump — the case min-bytes cannot catch", () => {
  const schemaOnly = `;
; Selected TOC Entries:
;
3410; 2606 16400 CONSTRAINT public people people_pkey postgres
3411; 1259 16401 INDEX public idx_people_name postgres
`;
  assert.equal(countTocTableEntries(schemaOnly), 0);
});

test("countTocTableEntries returns 0 for empty or non-TOC input rather than throwing", () => {
  assert.equal(countTocTableEntries(""), 0);
  assert.equal(countTocTableEntries("not a table of contents at all\njust words\n"), 0);
});

test("countTocTableEntries does not match TABLE inside another word", () => {
  // \b matters: a schema or table literally named e.g. "TABLESPACE" or "mutable" must not inflate
  // the count into a false pass on a dump that has no real tables.
  assert.equal(countTocTableEntries("3412; 3456 0 TABLESPACE - mutable_data postgres\n"), 0);
});
