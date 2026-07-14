import { test, describe } from "node:test";
import assert from "node:assert";
import { validateUrl } from "../src/tools/web.ts";

// These tests cover the deterministic, offline-safe layers of validateUrl
// (protocol check, "localhost" hostname, private IP literals) — the ones
// that don't require a real DNS lookup, so they run the same with or
// without network access. The DNS-rebinding layer (resolvesToPrivateHost)
// is reviewed but intentionally not covered here to keep this suite
// hermetic; it degrades safely (treats lookup failure as "not private").

describe("validateUrl (SSRF guard)", () => {
  test("rejects non-http(s) protocols", async () => {
    assert.match((await validateUrl("file:///etc/passwd"))!, /non-http/);
    assert.match((await validateUrl("ftp://example.com"))!, /non-http/);
  });

  test("rejects malformed URLs", async () => {
    assert.match((await validateUrl("not a url"))!, /non-http|Invalid URL/);
  });

  test("blocks localhost and *.localhost", async () => {
    assert.match((await validateUrl("http://localhost/"))!, /localhost/);
    assert.match((await validateUrl("http://LOCALHOST:8080/"))!, /localhost/i);
    assert.match((await validateUrl("http://foo.localhost/"))!, /localhost/);
  });

  test("blocks private/loopback/link-local IP literals", async () => {
    assert.match((await validateUrl("http://127.0.0.1/"))!, /private\/reserved IP/);
    assert.match((await validateUrl("http://169.254.169.254/latest/meta-data/"))!, /private\/reserved IP/);
    assert.match((await validateUrl("http://10.0.0.5/"))!, /private\/reserved IP/);
    assert.match((await validateUrl("http://192.168.1.1/"))!, /private\/reserved IP/);
  });

  test("blocks bracketed IPv6 loopback/link-local literals (regression)", async () => {
    assert.match((await validateUrl("http://[::1]/"))!, /private\/reserved IP/);
    assert.match((await validateUrl("http://[fe80::1]/"))!, /private\/reserved IP/);
  });

  test("allows a well-formed public https URL through the deterministic layers", async () => {
    // example.com resolves publicly; if this environment has no DNS access
    // resolvesToPrivateHost fails closed to "not private" (see its own
    // try/catch), so this assertion holds either way.
    const err = await validateUrl("https://example.com/page");
    assert.strictEqual(err, null);
  });
});
