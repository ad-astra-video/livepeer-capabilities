# Livepeer Capabilities Monitor - Multi-Region Architecture

## Overview
Deploy Livepeer gateway nodes across multiple Vultr regions, aggregate their capability data into a central dashboard with admin authentication.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MAIN SERVER                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   Caddy      │  │   Webapp     │  │   Admin API (FastAPI)    │  │
│  │   :8088      │  │   React      │  │   :8000                  │  │
│  │              │  │   Dashboard  │  │   - BetterAuth           │  │
│  │              │  │              │  │   - Vultr API mgmt       │  │
│  └──────────────┘  └──────────────┘  │   - Region config        │  │
│                                      │   - Instance lifecycle   │  │
│                                      └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ HTTP (capability JSON)
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                      VULTR REGIONAL INSTANCES                        │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  Region: NYC │  │  Region: LON │  │  Region: SJC │   ...        │
│  │              │  │              │  │              │              │
│  │  ┌────────┐  │  │  ┌────────┐  │  │  ┌────────┐  │              │
│  │  │Worker  │  │  │  │Worker  │  │  │  │Worker  │  │              │
│  │  │Agent   │  │  │  │Agent   │  │  │  │Agent   │  │              │
│  │  └────────┘  │  │  └────────┘  │  │  └────────┘  │              │
│  │       │      │  │       │      │  │       │      │              │
│  │  ┌────┴────┐ │  │  ┌────┴────┐ │  │  ┌────┴────┐ │              │
│  │  │Gateways │ │  │  │Gateways │ │  │  │Gateways │ │              │
│  │  │-trans   │ │  │  │-trans   │ │  │  │-trans   │ │              │
│  │  │-ai-batch│ │  │  │-ai-batch│ │  │  │-ai-batch│ │              │
│  │  │-lv2v    │ │  │  │-lv2v    │ │  │  │-lv2v    │ │              │
│  │  └─────────┘ │  │  └─────────┘ │  │  └─────────┘ │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Main Server (`docker-compose.yml`)
- **Caddy** (:8088) - Reverse proxy, serves webapp + API
- **Webapp** - React dashboard (existing, enhanced)
- **Admin API** (:8000) - FastAPI service for:
  - BetterAuth authentication (admin login)
  - Vultr instance management (create/destroy/list)
  - Region configuration
  - Receive capability data from workers
  - Store aggregated data in SQLite

### 2. Regional Worker (`worker/docker-compose.yml`)
Deployed on each Vultr instance:
- **Livepeer Gateways** - Same 3 gateway containers
- **Worker Agent** - Python script that:
  - Polls local gateways for capabilities
  - Sends JSON to main server API
  - Reports health/region info

### 3. Vultr Integration
- Use Vultr API to create/destroy instances
- Support configurable regions
- Use cloud-init for worker setup
- SSH key-based access

## Environment Variables

```
# Main Server
VULTR_API_KEY=xxx
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=bcrypt_hash
WORKER_API_TOKEN=secret_token_for_workers
DATABASE_URL=sqlite:///data/admin.db

# Regional Worker
MAIN_SERVER_URL=https://monitor.example.com
WORKER_API_TOKEN=secret_token_for_workers
WORKER_REGION=nyc1
```

## Data Flow
1. Admin configures regions via portal
2. Admin API creates Vultr instances via API
3. Worker agent starts, registers with main server
4. Worker polls local gateways every 30s
5. Worker POSTs capability JSON to main server
6. Webapp fetches aggregated data from main server API
7. Dashboard displays multi-region data

## API Endpoints (Admin API)

### Auth
- `POST /api/auth/login` - Login, returns JWT
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Current user

### Regions
- `GET /api/regions` - List configured regions
- `POST /api/regions` - Add region
- `DELETE /api/regions/:id` - Remove region

### Instances
- `GET /api/instances` - List Vultr instances
- `POST /api/instances` - Create instance in region
- `DELETE /api/instances/:id` - Destroy instance

### Capabilities (Worker-facing)
- `POST /api/capabilities` - Worker submits capability data
- `GET /api/capabilities` - Webapp fetches aggregated data

## Implementation Order
1. Create admin-api service with FastAPI + BetterAuth
2. Create worker agent container
3. Separate docker-compose for worker deployment
4. Update webapp to use new API endpoints
5. Add admin portal UI to webapp
6. Add Vultr instance management
