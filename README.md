# Webhook Dispatcher

**A production-grade webhook delivery system with at-least-once semantics, circuit breaking, SSRF protection, and real-time operational visibility.**

[![CI Pipeline](https://github.com/yashshinde7610/webhook-dispatcher/actions/workflows/ci.yml/badge.svg)](https://github.com/yashshinde7610/webhook-dispatcher/actions)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-9.x-47A248?logo=mongodb&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-Alpine-DC382D?logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-185_passing-22c55e)
![License](https://img.shields.io/badge/License-ISC-blue)

---

<p align="center">
  <img src="docs/dashboard.png" alt="Real-Time Operations Dashboard" width="800"/>
</p>

## Overview

Webhook Dispatcher solves a core infrastructure challenge: **reliably delivering HTTP callbacks at scale**. Services like Stripe, GitHub, and Shopify all maintain internal webhook dispatchers — this project implements the same patterns used in production at those companies.

**The Problem:** Naive webhook delivery (fire-and-forget HTTP POST) silently drops events when targets are down, networks fail, or services restart mid-delivery. At scale, this causes data loss, broken integrations, and customer-facing outages.

**The Solution:** A durable, queue-backed dispatch pipeline that persists every event to MongoDB before queuing it in Redis/BullMQ, guaranteeing **at-least-once delivery** with exponential backoff retries, circuit breaking for failing endpoints, and a zombie sweeper that recovers events lost during the dual-write window.

### Who Is This For?

- Backend engineers building event-driven architectures
- Teams needing reliable webhook delivery infrastructure
- Developers learning distributed systems patterns (circuit breakers, outbox pattern, idempotency)

---

## Features

### Core Delivery Engine
- **At-Least-Once Delivery** — Events are persisted to MongoDB before queuing, ensuring no data loss on crash
- **Exponential Backoff Retries** — 5 attempts with configurable exponential delays (1s, 2s, 4s, 8s, 16s)
- **Distributed Circuit Breaker** — Lua-scripted atomic state machine (CLOSED → OPEN → HALF_OPEN) prevents cascading failures
- **Zombie Sweeper (Outbox Pattern)** — Background process recovers events stuck in PENDING state due to dual-write failures
- **Idempotent Ingestion** — MongoDB unique sparse index on `idempotencyKey` provides atomic deduplication without Redis RAM pressure
- **DNS Error Classification** — `ENOTFOUND` (permanent: domain doesn't exist) vs `EAI_AGAIN` (transient: DNS resolver flake) — prevents killing live webhooks over temporary DNS blips

### Security
- **Helmet.js Security Headers** — Strict Content Security Policy with explicit directives for scripts, styles, fonts, and WebSocket connections
- **SSRF Protection** — DNS-resolution-based IP validation defeats nip.io aliases, octal encoding, and DNS rebinding attacks; covers RFC-1918, CGN (100.64/10), link-local, loopback, and RFC-3849 documentation prefix (2001:db8::/32)
- **DNS-Pinned HTTP Agents** — Axios connections are pinned to the validated IP, preventing TOCTOU attacks
- **HMAC-SHA256 Payload Signing** — Raw-byte signing ensures `HMAC(stored) === HMAC(sent) === HMAC(received)`
- **Constant-Time API Key Comparison** — `crypto.timingSafeEqual` defeats timing side-channel attacks
- **Joi Schema Validation** — All inputs validated before touching the database; blocks NoSQL injection operators
- **PII Redaction** — Recursive depth-limited scrubbing of sensitive fields (passwords, tokens, emails, SSNs, CVVs) from logs and dashboard
- **Non-Root Docker Container** — Runs as `node` user (uid 1000) with least-privilege access
- **`.dockerignore`** — Prevents `node_modules`, `tests/`, `.git` from leaking into production images

### Real-Time Operations Dashboard
- **Live WebSocket Event Feed** — Real-time delivery status updates via Socket.IO with token-based authentication
- **System Health Metrics** — Active workers, queue backlog, dead-letter count, Redis connection state
- **One-Click Replay** — Retry failed/dead events directly from the dashboard
- **Self-Contained Frontend** — Pre-compiled Tailwind CSS bundle (no CDN dependency); works offline and behind corporate firewalls
- **Batched WebSocket Emission** — Updates are buffered and flushed at intervals to prevent event-loop saturation
- **Connection Error Handling** — Invalid tokens surface an explicit "Auth Failed" state instead of hanging on "Connecting..."

### Performance & Scalability
- **50-Concurrent Worker Threads** — BullMQ worker processes up to 50 webhooks simultaneously
- **Redis-Adapted Socket.IO** — Pub/Sub adapter enables horizontal scaling across multiple API replicas
- **Bounded MongoDB Connection Pool** — Configurable `maxPoolSize` prevents connection exhaustion at scale
- **Pino Async Logger** — Structured JSON logging via worker thread; zero event-loop blocking
- **TTL Auto-Purge** — MongoDB TTL index automatically deletes events after 30 days
- **AbortController Timeouts** — Strict 5-second wall-clock timeout defeats tarpit servers

### API Design
- **RESTful Endpoints** — Standard CRUD + replay with proper HTTP semantics (202 Accepted for async operations)
- **Safe Partial Updates** — `PATCH` updates only schema-allowed mutable fields (`url`, `payload`, `lastError`)
- **Redis-Backed Rate Limiting** — Shared counters across replicas (configurable RPM per IP)
- **Pagination** — Cursor-based with `page`, `limit`, `total`, `pages` metadata
- **Trace IDs** — Every request gets a UUID for end-to-end correlation across logs

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Runtime** | Node.js 18+ | Server-side JavaScript |
| **Framework** | Express 5 | HTTP API server |
| **Security** | Helmet.js | HTTP security headers (CSP, HSTS, etc.) |
| **Database** | MongoDB (Mongoose 9) | Event persistence, idempotency, state machine |
| **Queue** | Redis + BullMQ | Durable job queue with retry/backoff |
| **Real-Time** | Socket.IO + Redis Adapter | Multi-replica WebSocket broadcasting |
| **Validation** | Joi | Input schema validation |
| **Logging** | Pino + pino-pretty | Structured async logging with PII redaction |
| **Auth** | HMAC-SHA256, API Keys | Webhook signing + API authentication |
| **DevOps** | Docker, Docker Compose | Containerized deployment |
| **CI/CD** | GitHub Actions | Automated testing + Docker build verification |
| **CSS** | Tailwind CSS 3 (pre-compiled) | Dashboard styling without CDN dependency |

---

## Architecture

<p align="center">
  <img src="docs/architecture.png" alt="System Architecture" width="800"/>
</p>

### Request Flow

```
Client → POST /api/events → [Rate Limiter] → [API Key Auth] → [Joi Validation]
    │
    ├─→ MongoDB: Persist Event (status: PENDING)
    │       └─ Idempotency check via unique sparse index (E11000 = duplicate)
    │
    ├─→ Redis/BullMQ: Enqueue job (jobId = MongoDB _id)
    │
    └─→ WebSocket: Emit "Pending" to dashboard (PII-redacted)

Worker picks up job from BullMQ:
    │
    ├─→ Circuit Breaker check (Lua script → CLOSED/OPEN/HALF_OPEN)
    ├─→ DNS Resolution → SSRF IP validation → Pin Agent to validated IP
    ├─→ HMAC-SHA256 sign raw payload bytes
    ├─→ Axios POST to target URL (5s AbortController timeout)
    │
    ├─ Success → recordSuccess() → persistState(COMPLETED) → WebSocket emit
    └─ Failure → classifyError(TRANSIENT/PERMANENT) → recordFailure()
                 → persistState(FAILED/DEAD) → BullMQ retry or give up
```

### Circuit Breaker State Machine

```mermaid
stateDiagram-v2
    [*] --> CLOSED
    CLOSED --> OPEN : 5 failures in 60s (Lua atomic)
    OPEN --> HALF_OPEN : Break duration expires (30s)
    HALF_OPEN --> CLOSED : Probe request succeeds
    HALF_OPEN --> OPEN : Probe request fails
```

### Zombie Sweeper (Outbox Pattern)

```mermaid
flowchart LR
    A[MongoDB: PENDING > 5min] -->|Sweep Query| B[Zombie Sweeper]
    B -->|Distributed Lock NX| C{Lock Acquired?}
    C -->|Yes| D[Re-queue to BullMQ]
    C -->|No| E[Skip - another replica sweeping]
    D --> F[Worker processes normally]
```

---

## Folder Structure

```
webhook-dispatcher/
├── server.js                    # API entry point: Express, Socket.IO, Helmet CSP, queue listeners
├── src/
│   ├── worker.js                # Background worker: job processor, delivery logic
│   ├── circuitBreaker.js        # Distributed circuit breaker with Lua atomicity
│   ├── batchProcessor.js        # Atomic MongoDB state persistence
│   ├── queue.js                 # BullMQ queue configuration with dedicated Redis connection
│   ├── redis.js                 # Shared ioredis client for circuit breaker, rate limiter, sweeper
│   ├── db.js                    # MongoDB connection with bounded pool size
│   ├── api/
│   │   ├── middleware.js        # API key auth (constant-time), rate limiting
│   │   ├── controllers/
│   │   │   └── eventController.js  # Business logic: CRUD, replay, idempotency
│   │   └── routes/
│   │       └── eventRoutes.js   # Route definitions and Joi validation schemas
│   ├── models/
│   │   └── Event.js             # Mongoose schema: state machine, TTL index, idempotency index
│   ├── services/
│   │   └── zombieSweeper.js     # Outbox pattern: recovers events lost during dual-write
│   └── utils/
│       ├── ssrf.js              # SSRF protection: IP validation, DNS resolution, range checks
│       ├── logger.js            # Pino async logger with built-in PII redaction paths
│       ├── redact.js            # Deep-clone redaction with depth limiting for dashboard/logs
│       └── workerUtils.js       # HMAC signing, error classification, HTTP status sanitization
├── public/
│   ├── index.html               # Dashboard HTML structure
│   ├── dashboard.js             # Dashboard logic: Socket.IO, auth, event rendering, replay
│   ├── styles.css               # Pre-compiled Tailwind CSS (no CDN dependency)
│   └── input.css                # Tailwind source
├── tests/
│   ├── helpers/
│   │   └── mocks.js             # Centralized mock factory: Event model, Redis, Queue, Express
│   ├── controller.test.js       # Controller unit tests (ingest, PATCH, replay, delete, get)
│   ├── ssrf.test.js             # SSRF protection tests (IPv4, IPv6, DNS, edge cases)
│   ├── middleware.test.js       # Auth middleware tests (safeCompare, validateApiKey)
│   ├── zombieSweeper.test.js    # Zombie sweeper tests (lock contention, empty sets)
│   ├── batchProcessor.test.js   # Batch processor tests (state persistence, error paths)
│   ├── redact.test.js           # PII redaction tests (recursive, depth-limited)
│   ├── circuitBreaker.test.js   # Circuit breaker state transition tests
│   ├── worker.test.js           # Worker utility tests (HMAC, error classification)
│   └── fullTest.js              # Comprehensive suite: 50 unit + 35 E2E tests
├── .github/workflows/
│   └── ci.yml                   # 3-stage CI: Unit tests → E2E tests → Docker build
├── docker-compose.yml           # Multi-container setup: API + Worker + Redis + MongoDB
├── Dockerfile                   # Production image: node:18-alpine, non-root, npm ci --omit=dev
├── .dockerignore                # Excludes node_modules, tests, .git from image
├── tailwind.config.js           # Tailwind CSS configuration
└── .env.example                 # Environment variable template
```

---

## Installation & Setup

### Prerequisites

- **Node.js** 18+ and **npm**
- **Docker** and **Docker Compose** (recommended) — OR local MongoDB and Redis instances

### Quick Start (Docker)

```bash
# 1. Clone the repository
git clone https://github.com/yashshinde7610/webhook-dispatcher.git
cd webhook-dispatcher

# 2. Create environment file
cp .env.example .env
# Edit .env and set your secrets (see Environment Variables section)

# 3. Start all services
docker compose up -d

# 4. Verify
curl http://localhost:3000/  # Should return the dashboard HTML
```

### Local Development (Without Docker)

```bash
# 1. Install dependencies
npm install

# 2. Start MongoDB and Redis locally (or via Docker)
docker run -d -p 27017:27017 mongo:latest
docker run -d -p 6379:6379 redis:alpine

# 3. Create .env file
cp .env.example .env
# Set: API_KEY, WEBHOOK_SECRET, DASHBOARD_TOKEN

# 4. Start the API server
node server.js

# 5. Start the worker (separate terminal)
node src/worker.js

# 6. Open the dashboard
# http://localhost:3000?token=YOUR_DASHBOARD_TOKEN
```

### Running Tests

```bash
# Node.js built-in test runner (100 isolated unit tests, no services needed)
npm test

# Legacy comprehensive suite (50 unit + 35 E2E)
npm run test:unit    # Unit tests only (no external services needed)
npm run test:e2e     # E2E tests (requires running API + Worker + Redis + MongoDB)
npm run test:full    # Full suite (unit + E2E)
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | API server port |
| `API_KEY` | **Yes** | — | API authentication key (constant-time compared) |
| `WEBHOOK_SECRET` | **Yes** | — | HMAC-SHA256 signing secret for webhook payloads |
| `DASHBOARD_TOKEN` | **Yes** | — | Read-only dashboard authentication (separate from API_KEY) |
| `DASHBOARD_ORIGIN` | No | `*` (dev) | Socket.IO CORS origin; set to your domain in production |
| `MONGO_URI` | No | `mongodb://127.0.0.1:27017/webhook-db` | MongoDB connection string |
| `MONGO_POOL_SIZE` | No | `20` (API) / `55` (Worker) | MongoDB connection pool limit |
| `REDIS_HOST` | No | `127.0.0.1` | Redis hostname |
| `REDIS_PORT` | No | `6379` | Redis port |
| `RATE_LIMIT_RPM` | No | `1000` | Max requests per minute per IP |
| `EVENT_TTL_SECONDS` | No | `2592000` (30 days) | Auto-purge TTL for events |
| `ZOMBIE_THRESHOLD_MS` | No | `300000` (5 min) | Age before a PENDING event is considered a zombie |
| `SWEEP_INTERVAL_MS` | No | `60000` (1 min) | How often the zombie sweeper runs |
| `WS_BATCH_INTERVAL_MS` | No | `500` | WebSocket emission batch interval |
| `LOG_LEVEL` | No | `debug` (dev) / `info` (prod) | Pino log level |

---

## API Documentation

All endpoints require the `x-api-key` header (except `GET /` which serves the dashboard).

### Endpoints

| Method | Endpoint | Description | Status |
|--------|----------|-------------|--------|
| `POST` | `/api/events` | Ingest a new webhook event | `202 Accepted` |
| `GET` | `/api/events` | List events (paginated, filterable) | `200 OK` |
| `GET` | `/api/events/:id` | Get event details | `200 OK` |
| `PATCH` | `/api/events/:id` | Update mutable fields (`url`, `payload`, `lastError`) | `200 OK` |
| `DELETE` | `/api/events/:id` | Delete an event | `200 OK` |
| `POST` | `/api/events/:id/replay` | Replay a failed/dead event | `200 OK` |

### Ingest Event

```bash
curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Idempotency-Key: unique-key-123" \
  -d '{
    "url": "https://example.com/webhook",
    "payload": { "event": "order.created", "orderId": 42 }
  }'
```

**Response (202):**
```json
{
  "status": "accepted",
  "message": "Job pushed to queue",
  "id": "6839a1b2c3d4e5f6a7b8c9d0",
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

### List Events with Filtering

```bash
# Get failed events, page 2
curl "http://localhost:3000/api/events?status=FAILED&page=2&limit=10" \
  -H "x-api-key: YOUR_API_KEY"
```

### PATCH Event

```bash
curl -X PATCH "http://localhost:3000/api/events/EVENT_ID" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://new-endpoint.com/hook", "payload": { "corrected": true } }'
```

### Error Response Format

All errors include a `traceId` for correlation:

```json
{
  "error": "Bad Request",
  "message": "url must be a valid HTTP/HTTPS URL",
  "code": "VALIDATION_FAILED",
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

---

## Security

### Implemented Protections

| Attack Vector | Defense | Implementation |
|---------------|---------|----------------|
| **SSRF** | DNS resolution + IP range validation | `isPrivateIP()` covers RFC-1918, CGN, link-local, loopback, IPv6 (::1, fe80::, fc00::, 2001:db8::) |
| **DNS Rebinding** | DNS-pinned HTTP agents | Custom `lookup` function locks Axios to the validated IP |
| **Timing Attacks** | `crypto.timingSafeEqual` | API key comparison always takes constant time |
| **NoSQL Injection** | Joi validation + `stripUnknown` | Rejects `$gt`, `$set`, and other MongoDB operators |
| **Mass Assignment** | Joi schema allowlist + `stripUnknown` | PATCH only updates schema-allowed mutable fields |
| **Payload Tampering** | HMAC-SHA256 signatures | Raw-byte signing prevents serialization mismatches |
| **XSS** | `escapeHTML()` in dashboard | All dynamic content is escaped before DOM insertion |
| **Clickjacking** | Helmet `X-Frame-Options` | Browser refuses to embed dashboard in iframes |
| **MIME Sniffing** | Helmet `X-Content-Type-Options` | `nosniff` prevents browser content-type guessing |
| **CSP Violations** | Helmet Content-Security-Policy | Explicit allowlists for scripts, styles, fonts, and WebSocket connections |
| **OOM** | Request body limit (1MB) | Express `limit: '1mb'` + Axios `maxContentLength` |
| **Tarpit Servers** | AbortController (5s) | Hard wall-clock timeout on entire request lifecycle |
| **Container Escape** | Non-root Docker user | Runs as `node` (uid 1000), not root |
| **Image Bloat** | `.dockerignore` | Prevents `node_modules`, `tests/`, `.git` from entering production image |

### Known Limitations

- `WEBHOOK_SECRET` is global (not per-destination)
- Dashboard stores token in `localStorage` (XSS on the same origin could steal it)
- No mTLS support for webhook delivery targets

---

## Testing

### Test Architecture

The project uses two complementary test suites:

| Suite | Runner | Tests | Dependencies | Command |
|-------|--------|-------|-------------|---------|
| **Unit (node:test)** | Node.js built-in | 100 tests | None (mock-injected) | `npm test` |
| **Comprehensive** | Custom runner | 50 unit + 35 E2E | API + Worker + Redis + MongoDB | `npm run test:full` |

### Mock Infrastructure

All `node:test` unit tests use a centralized mock factory (`tests/helpers/mocks.js`) that injects via `require.cache`:

- **Event Model** — Full Mongoose static chain (find → sort → skip → limit → lean) with configurable return data
- **Redis** — In-memory spy with `get`, `set`, `del`, `incr`, `eval` methods
- **BullMQ Queue** — Spy capturing `add()` calls with job data
- **Express req/res** — Chainable `res.status().json()` and standalone `res.json()` spies
- **DNS** — Mock `dns.promises.lookup` for SSRF hostname resolution tests

### What's Tested

| Module | Coverage |
|--------|----------|
| **SSRF** | Private IPv4/v6 ranges, public IPs, DNS hostname resolution, RFC-3849 documentation prefix, invalid inputs |
| **Controller** | Ingest (happy path + validation), idempotency collisions, PATCH (schema-based updates), replay, delete, get with pagination |
| **Middleware** | `safeCompare` (constant-time), `validateApiKey` (valid/invalid/missing), async Redis store initialization |
| **Zombie Sweeper** | Lock acquisition, lock contention (another replica), empty PENDING set, missing-field edge cases |
| **Batch Processor** | State persistence (COMPLETED/FAILED/DEAD), MongoDB write failures, missing event IDs |
| **Redact** | Recursive PII scrubbing, depth limiting, array handling, immutability, non-object passthrough |
| **Circuit Breaker** | CLOSED → OPEN → HALF_OPEN → CLOSED lifecycle |
| **Worker Utils** | HMAC generation, error classification (ENOTFOUND=permanent, EAI_AGAIN=transient, HTTP status mapping) |

### CI/CD Pipeline

The GitHub Actions pipeline runs on every push and PR to `main`:

```
Stage 1: Unit Tests (Node 18 + Node 20 matrix)
    │
    ├──→ Stage 2: E2E Tests (Redis + MongoDB service containers)
    │        └─ Boots API server + Worker in background
    │        └─ Runs full E2E suite against live infrastructure
    │
    └──→ Stage 3: Docker Build Verification
             └─ Builds production image and verifies layers
```

---

## Deployment

### Docker Compose (Development/Staging)

```bash
docker compose up -d          # Start all 4 containers
docker compose logs -f api    # Follow API logs
docker compose logs -f worker # Follow worker logs
docker compose up -d --build  # Rebuild after code changes
```

### Production Considerations

- Use managed MongoDB (Atlas) and Redis (ElastiCache/Upstash) instead of containerized instances
- Set `NODE_ENV=production` to disable pino-pretty and verbose logging
- Set `DASHBOARD_ORIGIN` to your actual domain (do not leave as `*` in production)
- Configure `MONGO_POOL_SIZE` based on replica count: `pool = concurrency + 5` per replica
- Add health check endpoints for container orchestrators
- Use secrets management (AWS Secrets Manager, Vault) instead of `.env` files
- Consider horizontal scaling: `docker compose up --scale api=3 --scale worker=3`

---

## Design Decisions

| Decision | Why |
|----------|-----|
| **Payload stored as String** | Prevents NoSQL injection (`$gt` in keys) and guarantees HMAC consistency — sign once, deliver exact bytes |
| **MongoDB idempotency (not Redis)** | Keys live as long as the event (30 days), not 5 minutes. Survives Redis restarts. Zero RAM pressure. |
| **Lua script for circuit breaker** | Sequential Redis commands (INCR → check → SET) race under 50-concurrency. Lua executes atomically. |
| **No PROCESSING write** | Eliminates 1 MongoDB write per job. BullMQ tracks in-flight state in Redis. Only write on final resolution. |
| **Separate BullMQ Redis connection** | BullMQ uses blocking commands (BLMOVE) that would deadlock the app's non-blocking operations. |
| **Zombie sweeper with distributed lock** | `SET NX` ensures only one replica sweeps at a time, preventing duplicate re-queues across horizontal replicas. |
| **Pre-compiled Tailwind CSS** | CDN dependency caused dashboard breakage behind corporate firewalls and adblockers. Local bundle is self-contained. |
| **External dashboard.js (not inline)** | Helmet's strict CSP blocks inline scripts by default. External file complies with `'self'` directive without weakening security. |
| **EAI_AGAIN → TRANSIENT** | DNS resolver can temporarily fail (`EAI_AGAIN`) without the domain being dead. Classifying as PERMANENT would incorrectly kill live webhooks. |
| **SSRF as isolated utility** | Extracting SSRF logic from `worker.js` into `src/utils/ssrf.js` enables unit testing without booting the full worker process. |

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Commit your changes with conventional commits (`feat:`, `fix:`, `docs:`)
4. Push and open a Pull Request

---

## License

This project is licensed under the [ISC License](LICENSE).
