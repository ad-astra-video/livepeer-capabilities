# Livepeer Capabilities Monitor

Deploy Livepeer gateway nodes across multiple Vultr regions and aggregate their network capabilities into a centralized React dashboard.

## How It Works

1. The admin portal spawns GPU instances in Vultr regions via cloud-init
2. Each instance runs 3 Livepeer gateways (Transcoding, AI Batch, AI LV2V) plus a worker agent
3. The worker agent polls local gateways, POSTs capability data back to the central API
4. The backend aggregates snapshots by region, deduplicating orchestrators across regions
5. The React dashboard displays the aggregated data with filtering, sorting, and search

## Architecture

```
                     ┌──────────────────────────┐
                     │       Main Server         │
                     │  Caddy :8088 (reverse     │
                     │  proxy) + React dashboard │
                     │  + FastAPI admin backend  │
                     └──────────┬───────────────┘
                                │ HTTP
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
       ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
       │ Vultr: NYC1  │ │ Vultr: LON1  │ │ Vultr: SJC   │  ...
       │              │ │              │ │              │
       │  3 gateways  │ │  3 gateways  │ │  3 gateways  │
       │  + agent     │ │  + agent     │ │  + agent     │
       └──────────────┘ └──────────────┘ └──────────────┘
```

## Project Structure

| Directory | Description |
|-----------|-------------|
| `backend/` | FastAPI admin API: auth, Vultr management, wallet pool, capability ingestion, aggregation |
| `webapp/` | React + TypeScript dashboard with Vite (region filters, sortable tables, search, live refresh) |
| `worker/` | Worker agent (`agent.py`) that polls gateways and reports capabilities; Dockerfile using `uv` |
| `webserver/` | Caddy reverse proxy configuration |
| `data/` | SQLite database (`admin.db`), wallet markers, S3 upload helpers |
| `Dockerfile` | Multi-stage build: compiles React webapp, bundles into Python backend container |
| `docker-compose.yml` | Local dev stack (backend, webapp, webserver) |

## Tech Stack

- **Backend**: Python FastAPI, SQLite, BetterAuth (JWT), Vultr API, S3 pre-signed URLs
- **Frontend**: React + TypeScript + Vite, live polling (30s), region filtering, full-text search
- **Infra**: Docker, Caddy reverse proxy, Vultr cloud VMs, cloud-init, tmpfs for wallet security
- **Wallets**: Stored in S3, delivered via pre-signed URLs to worker tmpfs (RAM-only, never persistent disk)

## Quick Start

```bash
# 1. Copy and configure environment variables
cp .env.example .env
# Edit .env with your credentials

# 2. Build and run locally
docker compose up --build

# 3. Access
# Dashboard: http://localhost:8088/app
# API:       http://localhost:8000
# Admin:     http://localhost:8088/admin
```

## Environment Variables

See `.env.example` for the full list. Required for production:

| Variable | Purpose |
|----------|---------|
| `MAIN_SERVER_URL` | Public URL workers call back to (must be internet-reachable) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin portal credentials |
| `JWT_SECRET` | Session/JWT signing key |
| `WORKER_API_TOKEN` | Shared secret authenticating worker-to-backend calls |
| `VULTR_API_KEY` | Vultr API for spawning/destroying GPU instances |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Wallet delivery via pre-signed URLs |
| `ARB_ETH_URL` | Arbitrum RPC endpoint for go-livepeer gateways |

## Key Endpoints

- `GET /api/capabilities/aggregated` - Aggregated, deduplicated capability data (used by dashboard)
- `POST /api/capabilities` - Worker submits capability snapshot (token-authed)
- `GET /api/instances` - List all Vultr instances
- `POST /api/instances` - Create new instance in a region
- `DELETE /api/instances/:id` - Destroy instance
- `GET /api/regions` - List configured regions

## Instance Lifecycle

`installing` (created) -> `active` (cloud-init complete) -> `completed` (all gateways reported) -> `destroyed` (Vultr VM deleted)

Instances are automatically destroyed after all 3 gateways report capabilities. The scheduler (`spawn_region_workers`) runs every 30 minutes to spawn new instances for configured regions.

## Security

- Wallets live in S3, delivered via time-limited pre-signed URLs
- Workers store wallets on tmpfs (RAM-only) — destroyed with the VM
- Backend never stores keystore or password data locally
- S3 objects are not deleted after download (wallets are shared resources)
