# tiny-clinic

A small fictional clinic app used to test the sandbox tool. All patients are invented.

```
node fixtures/tiny-clinic/server.mjs     # http://127.0.0.1:4010, any user, password "test-password"
```

It has what real apps make hard: server-built pages, a JSON API, a CSRF token, a session cookie, a search that
uses POST (a read that looks like a write), values that change on every request, an analytics beacon, a WebSocket
clock, and a "Sign and send chart" button that must never be clicked by a crawler.
