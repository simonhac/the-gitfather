import { test } from "node:test";
import assert from "node:assert/strict";
import { codeSpan, DEFAULT_MENTION, escapeSlack, isSafeMention, safeMention, safeUrl } from "../lib/slackText.js";

// Everything the scheduler posts from a client's bucket is untrusted (anyone with that client's CI R2
// key can write it), so these helpers are the whole of the injection defence: no text from there may
// mention, link or break out of its code span.

test("escapeSlack: escapes Slack's three control characters, so a mention or link is inert text", () => {
  assert.equal(escapeSlack("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  assert.equal(escapeSlack("<!channel>"), "&lt;!channel&gt;");
  assert.equal(escapeSlack("<!here> <@U0123ABC>"), "&lt;!here&gt; &lt;@U0123ABC&gt;");
  assert.equal(escapeSlack("<https://evil.example|click me>"), "&lt;https://evil.example|click me&gt;");
  assert.equal(escapeSlack("&lt;"), "&amp;lt;", "already-escaped input is escaped again, never trusted");
  // Formatting is not injection: left alone.
  assert.equal(escapeSlack("*bold* _it_ `code`"), "*bold* _it_ `code`");
});

test("escapeSlack: control characters and newlines flatten to single spaces, trimmed", () => {
  assert.equal(escapeSlack("line one\nline two\r\n\tindented"), "line one line two indented");
  assert.equal(escapeSlack("\u0000nul\u0007bell\u007fdel"), "nul bell del");
  assert.equal(escapeSlack("   padded   "), "padded");
  assert.equal(escapeSlack(""), "");
});

test("escapeSlack: caps the length BEFORE escaping, with an ellipsis", () => {
  const long = escapeSlack("x".repeat(600));
  assert.equal(long.length, 500);
  assert.ok(long.endsWith("…"));
  assert.equal(escapeSlack("abcdef", 4), "abc…");
  assert.equal(escapeSlack("abcd", 4), "abcd", "exactly at the cap is untouched");
  // Capped first, so an entity is never cut in half.
  assert.equal(escapeSlack("<".repeat(10), 5), "&lt;&lt;&lt;&lt;…");
});

test("codeSpan: escaped, flattened and backtick-safe, so the text cannot close its own span", () => {
  assert.equal(codeSpan("pg_dump failed"), "`pg_dump failed`");
  assert.equal(codeSpan("a`b ``c"), "`a'b ''c`");
  assert.equal(codeSpan("` <!channel> `"), "`' &lt;!channel&gt; '`");
  assert.equal(codeSpan("two\nlines"), "`two lines`");
  const capped = codeSpan("y".repeat(1000), 10);
  assert.equal(capped, `\`${"y".repeat(9)}…\``);
});

test("isSafeMention: accepts only the small mention grammar", () => {
  for (const ok of [
    "<!here>",
    "<!channel>",
    "<@U12>",
    "<@U0123ABCDEF>",
    "<@W0123ABC>",
    "<!subteam^S0123ABC>",
    "<!here> <@U0123ABC>",
    "<@U0123ABC> <@U0456DEF> <!subteam^S0123ABC> <!here>", // four is the limit
  ]) {
    assert.ok(isSafeMention(ok), ok);
  }
  for (const bad of [
    "",
    " ",
    "@here",
    "here",
    "<!everyone>",
    "<!here|here>",
    "<!subteam^S0123ABC|devs>", // a labelled group is still a link-ish form — refuse it
    "<@u0123abc>", // ids are upper-case
    "<@U1>", // too short
    "<@X0123ABC>",
    "<#C0123ABC>", // a channel link is not a mention
    "<https://evil.example|click>",
    "<!date^1392734382^{date}|x>",
    "<!here>  <!channel>", // one space only
    " <!here>",
    "<!here> ",
    "<!here>,<!channel>",
    "<!here> hi",
    "<!here> <!here> <!here> <!here> <!here>", // five
  ]) {
    assert.ok(!isSafeMention(bad), bad);
  }
});

test("safeMention: a safe mention passes through; anything else (or nothing) is the default", () => {
  assert.equal(DEFAULT_MENTION, "<!here>");
  assert.equal(safeMention("<!channel>"), "<!channel>");
  assert.equal(safeMention("<@U0123ABC> <!here>"), "<@U0123ABC> <!here>");
  for (const bad of [null, undefined, "", "<!everyone>", "<https://x|y>"]) assert.equal(safeMention(bad), "<!here>", String(bad));
});

test("safeUrl: only an https URL that cannot break Slack's <url|label> syntax", () => {
  const job = "https://github.com/o/r/actions/runs/1/job/2";
  assert.equal(safeUrl(job), job);
  assert.equal(safeUrl("https://dash.example.com/backups/boost/index.html?x=1#y"), "https://dash.example.com/backups/boost/index.html?x=1#y");
  for (const bad of [
    null,
    undefined,
    "",
    "http://dash.example.com/", // not https
    "javascript:alert(1)",
    "data:text/html,hi",
    "not a url",
    "https://x.example/a|b", // would end the link early
    "https://x.example/<!here>",
    "https://x.example/a b",
    "https://x.example/a\nb",
    `https://x.example/${"a".repeat(500)}`,
  ]) {
    assert.equal(safeUrl(bad), "", String(bad));
  }
});
