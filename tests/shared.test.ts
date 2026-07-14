import { test, describe } from "node:test";
import assert from "node:assert";
import { globToRegExp, htmlToText, truncate, isPrivateHost } from "../src/lib/shared.ts";

describe("globToRegExp", () => {
  test("* matches within a path segment, not across /", () => {
    const re = globToRegExp("*.ts");
    assert.ok(re.test("index.ts"));
    assert.ok(!re.test("src/index.ts"));
  });

  test("** matches across path separators", () => {
    const re = globToRegExp("**/*.ts");
    assert.ok(re.test("src/lib/shared.ts"));
    assert.ok(re.test("index.ts"));
  });

  test("matches relative paths the way grep_search/glob_files test them", () => {
    // Regression for the grep_search bug: the filter must match a path
    // relative to the search root, not just an absolute path.
    const re = globToRegExp("*.ts");
    assert.ok(re.test("shared.ts"));
    assert.ok(!re.test("/home/user/project/src/shared.ts"));
  });

  test("? matches a single non-separator character", () => {
    const re = globToRegExp("a?c");
    assert.ok(re.test("abc"));
    assert.ok(!re.test("a/c"));
  });

  test("special regex characters are escaped literally", () => {
    const re = globToRegExp("file(1).ts");
    assert.ok(re.test("file(1).ts"));
  });

  test("case-insensitive", () => {
    const re = globToRegExp("*.TS");
    assert.ok(re.test("index.ts"));
  });
});

describe("truncate", () => {
  test("returns short strings unchanged", () => {
    assert.strictEqual(truncate("hello", 100), "hello");
  });

  test("keeps head and tail, notes omitted count", () => {
    const s = "a".repeat(1000) + "b".repeat(1000);
    const out = truncate(s, 100);
    assert.ok(out.startsWith("a"));
    assert.ok(out.endsWith("b"));
    assert.ok(out.includes("truncated"));
    assert.ok(out.length < s.length);
  });
});

describe("htmlToText", () => {
  test("strips tags and decodes common entities", () => {
    const out = htmlToText("<p>Hello&nbsp;&amp;<b>World</b></p>");
    assert.ok(out.includes("Hello"));
    assert.ok(out.includes("&"));
    assert.ok(out.includes("World"));
    assert.ok(!out.includes("<"));
  });

  test("removes script and style blocks entirely", () => {
    const out = htmlToText("<script>alert(1)</script><style>.a{color:red}</style><p>Text</p>");
    assert.ok(!out.includes("alert"));
    assert.ok(!out.includes("color:red"));
    assert.ok(out.includes("Text"));
  });

  test("converts block-level closing tags to newlines", () => {
    const out = htmlToText("<p>One</p><p>Two</p>");
    assert.ok(out.includes("One\n"));
    assert.ok(out.trim().endsWith("Two"));
  });
});

describe("isPrivateHost", () => {
  test("blocks loopback and private IPv4 ranges", () => {
    assert.ok(isPrivateHost("127.0.0.1"));
    assert.ok(isPrivateHost("10.0.0.5"));
    assert.ok(isPrivateHost("172.16.0.1"));
    assert.ok(isPrivateHost("192.168.1.1"));
    assert.ok(isPrivateHost("169.254.169.254")); // cloud metadata IP
    assert.ok(isPrivateHost("0.0.0.0"));
  });

  test("blocks IPv6 loopback and link-local", () => {
    assert.ok(isPrivateHost("::1"));
    assert.ok(isPrivateHost("fe80::1"));
    assert.ok(isPrivateHost("fc00::1"));
  });

  test("allows public IPs and hostnames", () => {
    assert.ok(!isPrivateHost("8.8.8.8"));
    assert.ok(!isPrivateHost("example.com"));
    // isPrivateHost is a literal-IP matcher only — "localhost" is handled
    // separately by web.ts's validateUrl (see its own tests).
    assert.ok(!isPrivateHost("localhost"));
  });

  test("does not false-positive on IPs that merely start similarly", () => {
    assert.ok(!isPrivateHost("172.32.0.1")); // just outside 172.16-172.31
    assert.ok(!isPrivateHost("10.0.0.5.example.com"));
  });

  test("strips brackets so a raw URL.hostname value still matches (regression)", () => {
    // new URL("http://[::1]/").hostname === "[::1]" (brackets included) —
    // isPrivateHost must still recognize it as loopback, or SSRF checks
    // built on top of it silently let bracketed IPv6 literals through.
    assert.ok(isPrivateHost("[::1]"));
    assert.ok(isPrivateHost("[fe80::1]"));
    assert.ok(isPrivateHost("[fc00::1]"));
  });
});
