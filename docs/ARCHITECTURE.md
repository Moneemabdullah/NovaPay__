# NovaPay — Architecture

```mermaid
flowchart LR

    Client["Client"]

    subgraph EDGE["EDGE"]
        Nginx["Nginx<br/>:8080"]
        Gateway["API Gateway<br/>:3000"]
        Nginx --> Gateway
    end

    Client --> Nginx

    subgraph SERVICES["SERVICES"]
        direction TB
        Domain["Domain services<br/>:3001–3006"]
    end

    Gateway --> Domain

    subgraph DATA["DATA"]
        direction TB
        Postgres[("PostgreSQL<br/>6 logical DBs")]
        Redis[("Redis<br/>BullMQ + leases")]
    end

    Domain --> Postgres
    Domain --> Redis

    subgraph OBS["OBSERVABILITY"]
        direction TB
        Prom["Prometheus<br/>:9090"]
        Jaeger["Jaeger<br/>:16686"]
        Loki[("Loki<br/>internal")]
        Alloy["Alloy"]
        Grafana["Grafana<br/>:3007"]
        Prom --> Grafana
        Alloy --> Loki
        Loki --> Grafana
    end

    Domain -.->|/metrics| Prom
    Domain -.->|OTLP :4317| Jaeger
    Domain -.->|stdout| Alloy

    classDef edge fill:#ffffff,stroke:#2563eb,stroke-width:2px,color:#111827
    classDef service fill:#ffffff,stroke:#16a34a,stroke-width:2px,color:#111827
    classDef database fill:#ffffff,stroke:#d97706,stroke-width:2px,color:#111827
    classDef async fill:#ffffff,stroke:#7c3aed,stroke-width:2px,color:#111827
    classDef observability fill:#ffffff,stroke:#64748b,stroke-width:2px,color:#111827

    class Client edge
    class Nginx,Gateway edge
    class Domain service
    class Postgres database
    class Redis async
    class Prom,Jaeger,Loki,Alloy,Grafana observability

    style EDGE fill:transparent,stroke:#2563eb,stroke-width:1px
    style SERVICES fill:transparent,stroke:#16a34a,stroke-width:1px
    style DATA fill:transparent,stroke:#d97706,stroke-width:1px
    style OBS fill:transparent,stroke:#64748b,stroke-width:1px
```

## Service Boundaries

Each service owns one logical PostgreSQL database and exposes HTTP;
no service reads another's tables. The gateway routes by prefix and
injects service identity; it holds no business logic.

## Data Stores

Six logical databases on one Postgres 16 instance for local use
(`scripts/init-multi-db.sh`); Redis 7 serves BullMQ queues and
distributed lease locks (`SET key token NX PX`, Lua-guarded release).

## Flows

- **Transaction:** `POST /transactions` → idempotency gate → debit sender
  → ledger batch → credit recipient → conditional `COMPLETED`; failures
  compensate via idempotent reversal (`REVERSED`).
- **Ledger:** balanced debit/credit batches per transaction, live
  `SUM(debit)==SUM(credit)` invariant plus a SHA-256 audit hash chain.
- **Recovery:** in-process 60s scheduler re-runs stale `PROCESSING` rows
  through the same idempotent `execute()` under a per-transaction lease.
- **Payroll:** shared BullMQ queue, worker `concurrency: 5`, per-employer
  Redis lease for same-employer serialization, checkpoint-index resume.
- **FX:** 60s TTL single-use quotes, atomically consumed.
- **History:** keyset-paginated reads over composite wallet indexes.

## Trust Boundaries

External clients reach only gateway-routed paths. Services authenticate
to each other with per-service bearer tokens and route-scoped
authorization (`docs/SERVICE_TO_SERVICE_SECURITY.md`). `/internal/*`
accepts only the owning service and is never gateway-routed.

## Observability

Metrics (Prometheus), logs (Alloy → Loki), traces (OTel → Jaeger),
all explored from Grafana. Details: `docs/OBSERVABILITY.md`.
