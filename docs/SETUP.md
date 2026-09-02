# NovaPay — Installation & Environment Setup

## 1. Prerequisites

### Required Software

| Tool | Minimum Version | Purpose |
|------|----------------|---------|
| Docker Engine | 24.x | Container runtime |
| Docker Compose | v2 (bundled with Docker Desktop) | Multi-container orchestration |
| Git | 2.x | Source control |
| Node.js | 20.x | Local development (outside Docker) |
| npm | 10.x | Package management (local development) |

### Verify Your Environment

```bash
docker --version          # Docker Engine 24.x+
docker compose version    # Docker Compose v2+
git --version             # Git 2.x+
node --version            # Node.js 20.x+ (for local dev only)
npm --version             # npm 10.x+ (for local dev only)
```

### System Requirements

- **RAM:** 4 GB minimum (8 GB recommended for running both stacks simultaneously)
- **Disk:** 2 GB free for Docker images and volumes
- **OS:** Linux, macOS, or Windows with WSL 2

---

## 2. Clone the Repository

```bash
git clone <repository-url> novapay
cd novapay
```

---

## 3. Repository Structure

```
novapay/
├── infra/
│   ├── docker-compose.yml          # Production/assessment stack
│   ├── docker-compose.dev.yml      # Development stack
│   ├── nginx/
│   │   └── default.conf            # Reverse proxy config
│   ├── prometheus/
│   │   ├── prometheus.yml          # Scrape configuration
│   │   └── prometheus-alerts.yml   # Alert rules
│   └── grafana/
│       └── provisioning/
│           ├── dashboards/
│           │   ├── dashboard.yaml
│           │   └── novapay.json
│           ├── datasources/
│           │   └── prometheus.yaml
│           └── alerting/
│               ├── contactpoints.yaml
│               ├── invariant-alert.yaml
│               └── notification-policies.yaml
├── services/
│   ├── api-gateway/           # Reverse proxy + route aggregation
│   ├── account-service/       # Wallet management + field-level encryption
│   ├── transaction-service/   # Transfer processing + idempotency
│   ├── ledger-service/        # Double-entry bookkeeping + audit hash chain
│   ├── fx-service/            # Foreign exchange quotes + 60s TTL
│   ├── payroll-service/       # BullMQ job queue + batch processing
│   └── admin-service/         # Incident management + admin operations
├── scripts/
│   └── init-multi-db.sh       # PostgreSQL multi-database initializer
├── Makefile                   # Build/test/deploy shortcuts
├── README.md                  # Full API documentation
├── decisions.md               # Architecture decision records
└── .env.example               # Environment variable template
```

---

## 4. Environment Variables

### Required Variables (set automatically in Docker)

All environment variables are hardcoded in the Docker Compose files. **No `.env` file is required to run either stack.** The variables below are already configured:

| Variable | Value | Used By |
|----------|-------|---------|
| `NODE_ENV` | `development` | All services |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://jaeger:4317` | All services |
| `OTEL_SERVICE_NAME` | Service name | Each service |
| `PORT` | Service port | Each service |
| `DATABASE_URL` | `postgres://novapay:novapay@postgres:5432/<db>` | DB services |
| `FIELD_ENCRYPTION_KEK` | `novapay-local-dev-encryption-kek-2024` | account-service |
| `REDIS_URL` | `redis://redis:6379` | payroll-service |
| `QUEUE_NAME` | `payroll` | payroll-service |
| `FX_PROVIDER_DOWN` | `false` | fx-service |
| `POSTGRES_USER` | `novapay` | postgres |
| `POSTGRES_PASSWORD` | `novapay` | postgres |
| `POSTGRES_MULTIPLE_DATABASES` | `account_db,transaction_db,ledger_db,fx_db,payroll_db,admin_db` | postgres |

### Optional `.env` (for local development outside Docker)

A root `.env.example` exists for local development. Copy it:

```bash
cp .env.example .env
```

Contents:

```
NODE_ENV=development
DATABASE_URL=postgres://novapay:novapay@localhost:5432
REDIS_URL=redis://localhost:6379
FX_PROVIDER_DOWN=false
```

Each service under `services/` also has its own `.env.example`. Copy the relevant one when developing a service locally:

```bash
cp services/api-gateway/.env.example services/api-gateway/.env
```

---

## 5. Development Environment

The development stack uses **bind mounts** for live code editing. Source code changes are reflected immediately without rebuilding images.

### Start

```bash
make dev-up
# or
docker compose -f infra/docker-compose.dev.yml up -d
```

**First run** installs dependencies via an init container (`deps`). Subsequent starts skip this step automatically.

### Services & Ports (Development)

| Service | Host URL | Internal Port | Description |
|---------|----------|---------------|-------------|
| Nginx (API entry) | [http://localhost:8083](http://localhost:8083) | 8080 | Reverse proxy to api-gateway |
| Swagger UI | [http://localhost:8083/docs](http://localhost:8083/docs) | 8080 | Interactive API documentation |
| OpenAPI JSON | [http://localhost:8083/docs/json](http://localhost:8083/docs/json) | 8080 | OpenAPI 3.0.3 spec |
| Jaeger UI | [http://localhost:16687](http://localhost:16687) | 16686 | Distributed trace viewer |
| PostgreSQL | `localhost:5433` | 5432 | Database (user: `novapay`, password: `novapay`) |
| Redis | `localhost:6380` | 6379 | Queue backend for payroll-service |

### Internal Services (not exposed to host)

| Service | Internal Port | Database | Description |
|---------|---------------|----------|-------------|
| api-gateway | 3000 | — | Route aggregation + OTel instrumentation |
| account-service | 3001 | `account_db` | Wallet management + field-level encryption |
| transaction-service | 3002 | `transaction_db` | Transfer processing + idempotency |
| ledger-service | 3003 | `ledger_db` | Double-entry bookkeeping + audit hash chain |
| fx-service | 3004 | `fx_db` | Foreign exchange quotes + 60s TTL |
| payroll-service | 3005 | `payroll_db` | BullMQ job queue + batch processing |
| admin-service | 3006 | `admin_db` | Incident management + admin operations |

### Stop

```bash
make dev-down
# or
docker compose -f infra/docker-compose.dev.yml down
```

### Rebuild Dependencies

After changing `package.json` or `package-lock.json`:

```bash
make dev-build
# or
docker compose -f infra/docker-compose.dev.yml up -d --force-recreate deps
```

### View Logs

```bash
make dev-logs
# or
docker compose -f infra/docker-compose.dev.yml logs -f
```

### Container Status

```bash
make dev-ps
# or
docker compose -f infra/docker-compose.dev.yml ps
```

---

## 6. Development Environment with Monitoring

The development stack supports an optional **monitoring profile** that adds Prometheus, Grafana, and cAdvisor. By default, these are excluded for faster startup.

### Start with Monitoring

```bash
docker compose -f infra/docker-compose.dev.yml --profile monitoring up -d
```

### Additional Services & Ports

| Service | Host URL | Internal Port | Description |
|---------|----------|---------------|-------------|
| Prometheus | [http://localhost:9091](http://localhost:9091) | 9090 | Metrics collection + alerting |
| Grafana | [http://localhost:3008](http://localhost:3008) | 3000 | Dashboards (user: `admin`, password: `admin`) |
| cAdvisor | [http://localhost:8082](http://localhost:8082) | 8080 | Container resource metrics |

### Grafana Dashboard

The **NovaPay — Payments & Ledger** dashboard is auto-provisioned with 23 panels:

- Transaction throughput + failure rates
- HTTP latency histograms (p95, p99)
- Ledger invariant violations
- Payroll queue depth
- FX provider failures
- Per-service CPU, memory, network, filesystem metrics (via cAdvisor)
- Per-service UP/DOWN health status

### Prometheus Targets

All 7 application services + cAdvisor are scraped every 5 seconds (cAdvisor: 15 seconds). View targets at [http://localhost:9091/targets](http://localhost:9091/targets).

### Alert Rules

| Alert | Condition | Severity |
|-------|-----------|----------|
| LedgerInvariantViolation | `sum(ledger_invariant_violations_total) > 0` | Critical |

---

## 7. Assessment / Production Stack

The production stack builds Docker images from Dockerfiles and runs all services with full observability built-in (no profile required).

### Start

```bash
make up
# or
docker compose -f infra/docker-compose.yml up --build -d
```

**Note:** The first build takes several minutes as it runs `npm ci` and `prisma generate` inside each container.

### Services & Ports

| Service | Host URL | Internal Port | Description |
|---------|----------|---------------|-------------|
| Nginx (API entry) | [http://localhost:8080](http://localhost:8080) | 8080 | Reverse proxy to api-gateway |
| Swagger UI | [http://localhost:8080/docs](http://localhost:8080/docs) | 8080 | Interactive API documentation |
| OpenAPI JSON | [http://localhost:8080/docs/json](http://localhost:8080/docs/json) | 8080 | OpenAPI 3.0.3 spec |
| Prometheus | [http://localhost:9090](http://localhost:9090) | 9090 | Metrics collection + alerting |
| Grafana | [http://localhost:3007](http://localhost:3007) | 3000 | Dashboards (user: `admin`, password: `admin`) |
| Jaeger UI | [http://localhost:16686](http://localhost:16686) | 16686 | Distributed trace viewer |
| Jaeger OTLP gRPC | `localhost:4317` | 4317 | OpenTelemetry gRPC endpoint |
| Jaeger OTLP HTTP | `localhost:4318` | 4318 | OpenTelemetry HTTP endpoint |
| cAdvisor | [http://localhost:8081](http://localhost:8081) | 8080 | Container resource metrics |
| PostgreSQL | `localhost:5432` | 5432 | Database (user: `novapay`, password: `novapay`) |
| Redis | `localhost:6379` | 6379 | Queue backend for payroll-service |

### Stop

```bash
make down
# or
docker compose -f infra/docker-compose.yml down
```

### View Logs

```bash
make logs
# or
docker compose -f infra/docker-compose.yml logs -f
```

---

## 8. Running Both Stacks Simultaneously

Both stacks can run side by side. They use **different Docker project names** and **different host ports** to avoid conflicts.

| Resource | Production Stack | Development Stack |
|----------|------------------|-------------------|
| Project name | `infra` | `novapay-dev` |
| Docker network | `infra_default` | `novapay-dev_default` |
| PostgreSQL | `localhost:5432` | `localhost:5433` |
| Redis | `localhost:6379` | `localhost:6380` |
| Nginx (API) | `localhost:8080` | `localhost:8083` |
| Prometheus | `localhost:9090` | `localhost:9091` |
| Grafana | `localhost:3007` | `localhost:3008` |
| Jaeger UI | `localhost:16686` | `localhost:16687` |
| Jaeger gRPC | `localhost:4317` | `localhost:4319` |
| Jaeger HTTP | `localhost:4318` | `localhost:4320` |
| cAdvisor | `localhost:8081` | `localhost:8082` |

### Start Both

```bash
# Start production stack first (builds images)
docker compose -f infra/docker-compose.yml up --build -d

# Start development stack with monitoring
docker compose -f infra/docker-compose.dev.yml --profile monitoring up -d
```

### Stop Both

```bash
docker compose -f infra/docker-compose.yml down
docker compose -f infra/docker-compose.dev.yml --profile monitoring down
```

### Network Isolation

Each stack runs on its own Docker network (`infra_default` or `novapay-dev_default`). Services from one stack **cannot** reach services on the other stack via Docker DNS. Prometheus on each stack only scrapes targets on its own network.

---

## 9. Database Management

### Multi-Database Setup

PostgreSQL is initialized with 6 databases via `scripts/init-multi-db.sh`:

| Database | Service |
|----------|---------|
| `account_db` | account-service |
| `transaction_db` | transaction-service |
| `ledger_db` | ledger-service |
| `fx_db` | fx-service |
| `payroll_db` | payroll-service |
| `admin_db` | admin-service |

### Prisma Migrations

Migrations run **automatically** on container startup:

- **Production stack:** Each service runs `npx prisma migrate deploy` as part of its entrypoint
- **Development stack:** The `deps` container runs `npx prisma generate` for all services. Each service then runs `npx prisma migrate deploy` on startup

### Manual Migration (local development)

```bash
make migrate
# or per-service:
cd services/account-service && npx prisma migrate deploy
```

### Manual Prisma Client Generation

```bash
make generate
# or per-service:
cd services/account-service && npx prisma generate
```

---

## 10. Running Tests

### Unit Tests

```bash
make test
# or per-service:
cd services/transaction-service && npm test
```

### Integration Tests

Integration tests require a running PostgreSQL instance:

```bash
# Start databases
make init-db

# Run integration tests (services that have vitest.integration.config.ts)
make integration-test
# or per-service:
cd services/transaction-service && npm run test:integration
```

Services with integration tests: `transaction-service`, `ledger-service`, `payroll-service`.

### Type Checking

```bash
# Per-service:
cd services/api-gateway && npm run build
```

---

## 11. API Reference

### Base URL

| Stack | Base URL |
|-------|----------|
| Production | [http://localhost:8080](http://localhost:8080) |
| Development | [http://localhost:8083](http://localhost:8083) |

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/accounts/users` | Create user account |
| `POST` | `/accounts/wallets` | Create wallet |
| `GET` | `/accounts/wallets/:userId` | List wallets for user |
| `GET` | `/accounts/wallets/:walletId/balance` | Get wallet balance |
| `POST` | `/accounts/wallets/:walletId/operations` | Debit/credit wallet |
| `POST` | `/transactions` | Create transfer (requires `Idempotency-Key` header) |
| `POST` | `/transfers/international` | Create international transfer (requires `Idempotency-Key` header) |
| `POST` | `/ledger/batches` | Post double-entry ledger batch |
| `GET` | `/ledger/batches/:transactionId` | Get ledger batch for transaction |
| `GET` | `/ledger/invariant-check` | Verify ledger invariant |
| `GET` | `/ledger/audit/verify` | Verify audit hash chain |
| `POST` | `/fx/quote` | Request FX quote |
| `GET` | `/fx/quote/:id` | Get FX quote by ID |
| `POST` | `/fx/quote/:id/consume` | Consume FX quote |
| `POST` | `/payroll/jobs` | Submit payroll job |
| `GET` | `/payroll/jobs/:id` | Get payroll job status |
| `POST` | `/admin/incidents` | Report incident |

### Interactive Documentation

- **Swagger UI:** [http://localhost:8080/docs](http://localhost:8080/docs) (production) or [http://localhost:8083/docs](http://localhost:8083/docs) (development)
- **OpenAPI Spec:** [http://localhost:8080/docs/json](http://localhost:8080/docs/json) (production) or [http://localhost:8083/docs/json](http://localhost:8083/docs/json) (development)

---

## 12. Observability

### OpenTelemetry (Tracing)

All services export traces via OTLP gRPC to Jaeger:

| Stack | OTLP Endpoint |
|-------|---------------|
| Production | `http://localhost:4317` |
| Development | `http://localhost:4319` |

**Jaeger UI:**
- Production: [http://localhost:16686](http://localhost:16686)
- Development: [http://localhost:16687](http://localhost:16687)

### Prometheus (Metrics)

All services expose a `/metrics` endpoint scraped by Prometheus:

| Stack | Prometheus UI |
|-------|--------------|
| Production | [http://localhost:9090](http://localhost:9090) |
| Development | [http://localhost:9091](http://localhost:9091) |

### Grafana (Dashboards)

Pre-configured with Prometheus datasource and the NovaPay dashboard:

| Stack | Grafana UI | Credentials |
|-------|------------|-------------|
| Production | [http://localhost:3007](http://localhost:3007) | admin / admin |
| Development | [http://localhost:3008](http://localhost:3008) | admin / admin |

### cAdvisor (Container Metrics)

| Stack | cAdvisor UI |
|-------|-------------|
| Production | [http://localhost:8081](http://localhost:8081) |
| Development | [http://localhost:8082](http://localhost:8082) |

---

## 13. Quick Reference

### Common Make Targets

| Target | Description |
|--------|-------------|
| `make up` | Build + start production stack |
| `make down` | Stop production stack |
| `make logs` | Tail production logs |
| `make ps` | Show production containers |
| `make dev-up` | Start development stack |
| `make dev-down` | Stop development stack |
| `make dev-logs` | Tail development logs |
| `make dev-ps` | Show development containers |
| `make dev-build` | Rebuild dev dependencies |
| `make test` | Run all unit tests |
| `make integration-test` | Run all integration tests |
| `make migrate` | Apply Prisma migrations |
| `make generate` | Generate Prisma clients |

### Health Checks

```bash
# Nginx health (production)
curl http://localhost:8080/health

# Individual service health (production)
curl http://localhost:3001/health   # account-service
curl http://localhost:3002/health   # transaction-service
curl http://localhost:3003/health   # ledger-service
curl http://localhost:3004/health   # fx-service
curl http://localhost:3005/health   # payroll-service
curl http://localhost:3006/health   # admin-service
```

### Nginx Configuration

The nginx reverse proxy (`infra/nginx/default.conf`) forwards all traffic from port 8080 (production) or 8083 (development) to the api-gateway on port 3000. It also exposes a health endpoint at `/health` that returns `{"status":"ok","service":"nginx"}`.

---

## 14. Troubleshooting

### Port Conflicts

If a port is already in use, check which process owns it:

```bash
lsof -i :8080     # Linux/macOS
netstat -tlnp | grep 8080  # Linux
```

Stop the conflicting service or use the other stack (development uses different ports).

### Database Connection Errors

Ensure PostgreSQL is healthy before services start:

```bash
docker compose -f infra/docker-compose.yml ps postgres
# or
docker compose -f infra/docker-compose.dev.yml ps postgres
```

### Stale Dependencies (Development)

If the `deps` container cached an old dependency hash:

```bash
docker compose -f infra/docker-compose.dev.yml up -d --force-recreate deps
```

### Resetting Development Data

```bash
docker compose -f infra/docker-compose.dev.yml down -v   # removes named volumes
docker compose -f infra/docker-compose.dev.yml up -d     # fresh start
```

### Viewing Container Logs

```bash
# Specific service
docker compose -f infra/docker-compose.yml logs -f transaction-service

# All services
docker compose -f infra/docker-compose.yml logs -f
```
