---
name: mobile-auth-swift-convex-betterauth-configuration
description: >
  Configure Better Auth on a self-hosted Convex backend and connect it to an iOS SwiftUI app.
  Use when setting up email/password authentication with @convex-dev/better-auth, wiring iOS
  BetterAuthService, fixing iOS simulator QUIC/HTTP3 Cloudflare connection failures, parsing
  auth session responses, or debugging sign-up/sign-in errors in this stack.
  Covers: Convex auth.ts setup, http.ts routing, iOS TCPHTTPClient (NWConnection), AuthSession
  model, session token storage, and known failure modes with their exact fixes.
---

# Better Auth + Convex + iOS Swift — Configuration Guide

## Stack

- Backend: Convex self-hosted, `@convex-dev/better-auth`, `better-auth@1.5.3`
- iOS: SwiftUI + SwiftData, `BetterAuthService` in `AuthViewModel.swift`
- CDN: Cloudflare (proxied, HTTP/3 enabled by default)

---

## Backend Setup

### `convex/auth.ts`

```typescript
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { components } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: process.env.SITE_URL!,   // https://<site-subdomain>
    basePath: "/auth",
    secret: process.env.BETTER_AUTH_SECRET!,
    database: authComponent.adapter(ctx),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [convex({ authConfig })],
    // ⚠️ Do NOT add admin() plugin — it writes fields not in @convex-dev/better-auth schema
    // causing FAILED_TO_CREATE_USER on every sign-up
  });
```

### `convex/http.ts`

```typescript
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

// ⚠️ http.ts CANNOT use "use node" directive
// ⚠️ Do NOT register user routes under /api/* (Convex reserves it)

authComponent.registerRoutesLazy(http, createAuth, {
  basePath: "/auth",
  cors: true,
});

export default http;
```

### Required Convex env vars

```
BETTER_AUTH_SECRET=<random secret>
SITE_URL=https://<convex-site-subdomain>   # NOT the API subdomain
BETTER_AUTH_API_KEY=<api key if using dash>
```

### `package.json` (project root)

```json
{
  "dependencies": {
    "@convex-dev/better-auth": "latest",
    "better-auth": "1.5.3",
    "convex": "^1.25.0"
  }
}
```

**Pitfalls:**
- `@better-auth/infra` / `dash()` plugin cannot be used in Convex HTTP actions — pulls in Node.js deps (`xml-encryption`, `node-rsa`, `fs`, `crypto`, etc.) that are unavailable in Convex's runtime. Implement `/auth/dash/validate` and `/auth/dash/config` manually using `jose`.
- Stale `.js` files in `convex/` root cause "Two output files share the same path" bundler errors — delete them (not `_generated/`).
- `convex/package.json` and `convex/tsconfig.json` must NOT exist.

---

## iOS Networking — Critical: Cloudflare HTTP/3 Problem

**Root cause:** Cloudflare publishes a `TYPE65` (HTTPS/SVCB) DNS record with `alpn=h3,h2`. iOS 15+ discovers this via DNS and immediately attempts QUIC (HTTP/3) on the first request — **before** any URLSession configuration can intervene. QUIC fails in iOS Simulator with error `-1005 [4:-4]`.

**`URLSession` cannot fix this** — no public API to disable HTTP/3 when advertised via DNS HTTPS records. `assumesHTTP3Capable` does not exist in iOS 18 SDK.

**Fix: Use `NWConnection` (Network framework) with explicit SNI and TCP-only parameters.**

```swift
import Network

private class TCPHTTPClient {
    private let hostname: String
    private let queue = DispatchQueue(label: "auth.tcp", qos: .userInitiated)

    init(hostname: String) { self.hostname = hostname }

    func post(path: String, body: Data, headers: [String: String] = [:]) async throws -> (statusCode: Int, data: Data) {
        var h = headers
        h["Host"] = hostname; h["Content-Type"] = "application/json"
        h["Content-Length"] = "\(body.count)"; h["Connection"] = "close"
        h["Accept"] = "application/json"
        return try await request(method: "POST", path: path, headers: h, body: body)
    }

    func get(path: String, headers: [String: String] = [:]) async throws -> (statusCode: Int, data: Data) {
        var h = headers
        h["Host"] = hostname; h["Accept"] = "application/json"; h["Connection"] = "close"
        return try await request(method: "GET", path: path, headers: h, body: nil)
    }

    private func request(method: String, path: String, headers: [String: String], body: Data?) async throws -> (statusCode: Int, data: Data) {
        let ip = try resolveIPv4()
        let conn = try await connect(ip: ip)
        defer { conn.cancel() }
        var req = "\(method) \(path) HTTP/1.1\r\n"
        for (k, v) in headers { req += "\(k): \(v)\r\n" }
        req += "\r\n"
        var data = Data(req.utf8)
        if let body { data.append(body) }
        try await send(conn, data: data)
        let raw = try await receiveAll(conn)
        return try parseHTTP(raw)
    }

    private func resolveIPv4() throws -> String {
        // Uses getaddrinfo (A records only) — bypasses HTTPS/SVCB DNS records that advertise HTTP/3
        var hints = addrinfo(); hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(hostname, nil, &hints, &res) == 0, let info = res else { throw AuthError.networkError }
        defer { freeaddrinfo(info) }
        return info.pointee.ai_addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { ptr in
            var addr = ptr.pointee.sin_addr
            var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            inet_ntop(AF_INET, &addr, &buf, socklen_t(INET_ADDRSTRLEN))
            return String(cString: buf)
        }
    }

    private func connect(ip: String) async throws -> NWConnection {
        let tls = NWProtocolTLS.Options()
        // Set correct SNI so Cloudflare serves the right TLS certificate for the domain
        sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, hostname)
        let params = NWParameters(tls: tls, tcp: NWProtocolTCP.Options()) // TCP only, no QUIC
        let conn = NWConnection(host: NWEndpoint.Host(ip), port: 443, using: params)
        return try await withCheckedThrowingContinuation { cont in
            var fired = false
            conn.stateUpdateHandler = { state in
                guard !fired else { return }
                switch state {
                case .ready: fired = true; cont.resume(returning: conn)
                case .failed(let e): fired = true; cont.resume(throwing: e)
                case .cancelled: fired = true; cont.resume(throwing: AuthError.networkError)
                default: break
                }
            }
            conn.start(queue: self.queue)
        }
    }

    private func send(_ conn: NWConnection, data: Data) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            conn.send(content: data, completion: .contentProcessed { err in
                if let err { c.resume(throwing: err) } else { c.resume() }
            })
        }
    }

    private func receiveAll(_ conn: NWConnection) async throws -> Data {
        var buf = Data()
        while true {
            let chunk: Data = try await withCheckedThrowingContinuation { c in
                conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, err in
                    if let err { c.resume(throwing: err); return }
                    if let data, !data.isEmpty { c.resume(returning: data); return }
                    c.resume(returning: Data())
                }
            }
            if chunk.isEmpty { break }
            buf.append(chunk)
        }
        return buf
    }

    private func parseHTTP(_ data: Data) throws -> (statusCode: Int, data: Data) {
        let sep = Data("\r\n\r\n".utf8)
        guard let range = data.range(of: sep) else { throw AuthError.networkError }
        let headerData = data[data.startIndex..<range.lowerBound]
        let rawBody = data[range.upperBound...]
        guard let hdr = String(data: headerData, encoding: .utf8),
              let statusLine = hdr.split(separator: "\r\n").first else { throw AuthError.networkError }
        let parts = statusLine.split(separator: " ", maxSplits: 2)
        guard parts.count >= 2, let code = Int(parts[1]) else { throw AuthError.networkError }
        let isChunked = hdr.lowercased().contains("transfer-encoding: chunked")
        let body = isChunked ? (decodeChunked(Data(rawBody)) ?? Data(rawBody)) : Data(rawBody)
        return (code, body)
    }

    private func decodeChunked(_ data: Data) -> Data? {
        var result = Data(); var remaining = data
        while !remaining.isEmpty {
            guard let crlfRange = remaining.range(of: Data("\r\n".utf8)) else { break }
            let sizeLine = remaining[remaining.startIndex..<crlfRange.lowerBound]
            guard let sizeHex = String(data: sizeLine, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  let chunkSize = Int(sizeHex, radix: 16) else { break }
            if chunkSize == 0 { break }
            let chunkStart = crlfRange.upperBound
            guard remaining.count >= chunkStart.advanced(by: chunkSize) else { break }
            let chunkEnd = chunkStart.advanced(by: chunkSize)
            result.append(remaining[chunkStart..<chunkEnd])
            let nextStart = chunkEnd.advanced(by: 2)
            remaining = remaining[min(nextStart, remaining.endIndex)...]
        }
        return result.isEmpty ? nil : result
    }
}
```

---

## iOS Auth Session Models

Better Auth returns different shapes depending on endpoint:

```swift
struct AuthSession: Codable {
    let user: AuthUser?
    let token: String?        // top-level on sign-in/sign-up responses
    let session: SessionInfo? // nested on get-session response
}

struct AuthUser: Codable {
    let id: String
    let email: String
    let name: String
    let image: String?
    let emailVerified: Bool
}

struct SessionInfo: Codable {
    let token: String
    let expiresAt: Int64  // ⚠️ Unix timestamp milliseconds — NOT a String
}
```

Token extraction:
```swift
let token = session.token ?? session.session?.token
```

---

## iOS BetterAuthService — Key Points

- Store token in `UserDefaults` key `"ba_session_token"`
- `checkSession()` returns early without network call if no stored token
- Client-side validation: password ≥ 8 chars, email non-empty, name non-empty
- Parse server error messages: `{ "message": "..." }` JSON from non-2xx responses
- `signOut()` clears token + sets `isAuthenticated = false` locally even if request fails

---

## Known Failure Modes

| Error | Cause | Fix |
|-------|-------|-----|
| `FAILED_TO_CREATE_USER` on sign-up | `admin()` plugin writes `role`/`banned`/`banReason` fields not in `@convex-dev/better-auth` schema | Remove `admin()` from `plugins` array |
| `-1005 [4:-4]` network connection lost | Cloudflare HTTPS DNS TYPE65 record forces iOS QUIC — QUIC fails in simulator | Use `NWConnection` with TCP + `sec_protocol_options_set_tls_server_name` |
| `-1200` SSL error when connecting to IP | URLSession sets SNI from URL hostname (IP) — Cloudflare can't match cert | Use `NWConnection` so SNI is set independently from connection IP |
| "Two output files share the same path" | Stale `.js` files in `convex/` root | Delete all `.js` files from `convex/` root (not `_generated/`) |
| Node.js module errors in `http.ts` | `@better-auth/infra` imports `node-rsa`, `xml-encryption`, `fs`, etc. | Never use `@better-auth/infra` in Convex HTTP actions; implement dashboard routes manually with `jose` |
| `http.ts` deployment error | `"use node"` directive added | Remove it — Convex HTTP actions cannot use Node.js runtime |
| `AuthSession` decode failure | `expiresAt` declared as `String` but backend sends `Int64` | Change type to `Int64` |
