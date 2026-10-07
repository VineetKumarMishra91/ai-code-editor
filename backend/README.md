# AI Code Editor — Backend

Backend for an AI-powered, Cursor-style online code editor. It is a **Node.js microservices** system: a single API gateway sits in front of six independent services (auth, projects, files, AI agent, terminal, payments) that share MongoDB and Redis.

## Features

- **Firebase authentication** with server-side Redis sessions (httpOnly cookie, 7-day expiry)
- **Project management** — create, list, star, open and delete projects (Redis-cached lists)
- **Virtual file system** — nested files and folders stored in MongoDB, with soft delete and tree building
- **AI coding agent** — a LangGraph agent (via OpenRouter) that reads and edits the project's files with tools, streamed to the client over Server-Sent Events
- **Interactive terminal** — per-project shell over Socket.IO + `node-pty`, with the project's files synced into a workspace
- **Credits & payments** — credit-based AI usage, with Razorpay checkout and signature verification

## Architecture

```
                          ┌────────────────────────────┐
   Frontend ──cookie────► │  Gateway  :8000            │
                          │  CORS · session check      │
                          └──────────────┬─────────────┘
                                         │  Redis session → x-user-id header
      ┌──────────┬────────────┬──────────┼───────────┬───────────┐
      ▼          ▼            ▼          ▼           ▼           ▼
   Auth :8001  Project :8002  File :8003  AI :8004  Terminal :8005  Payment :8006
      │          │            │          │  │         │ (WebSocket)    │
      └──────────┴────── MongoDB ────────┘  │         └─► File svc     └─► Auth svc
                  Redis (sessions, cache)   └─► OpenRouter LLM         (credits)
                                            └─► File svc (tools)
```

The gateway validates the `session` cookie against Redis, then forwards requests to the right service with the authenticated user's id in an `x-user-id` header. Downstream services trust that header, so **they must not be exposed publicly** — only the gateway should be reachable.

## Tech Stack

| Area | Technology |
| --- | --- |
| Runtime / framework | Node.js (ES modules), Express 5 |
| Database | MongoDB with Mongoose |
| Cache / sessions | Redis (`ioredis`) |
| Auth | Firebase Admin SDK |
| AI | LangChain, LangGraph, OpenRouter (`deepseek/deepseek-chat`) |
| Realtime | Socket.IO, `node-pty` |
| Payments | Razorpay |
| Proxy | `express-http-proxy`, `http-proxy` |
| Containers | Docker |

## Project Structure

```
backend/
├── docker-compose.yml        # Redis for local development
├── package.json
├── gateway/                  # API gateway (auth guard + reverse proxy)
│   ├── controllers/          # /api/me
│   ├── middleware/protect.js # Redis session check
│   └── utils/proxyWithHeader.js
├── services/
│   ├── auth/                 # Login/logout, user model, credits
│   ├── project/              # Project CRUD, starring
│   ├── file/                 # File/folder CRUD, tree builder
│   ├── ai/                   # LangGraph agent, tools, SSE endpoint
│   ├── terminal/             # Socket.IO + pty shell sessions
│   └── payment/              # Razorpay orders and verification
└── shared/redis/redis.js     # Shared Redis client
```

## Services

| Service | Default port | Responsibility |
| --- | --- | --- |
| Gateway | 8000 | Entry point, CORS, session auth, routing, WebSocket proxy |
| Auth | 8001 | Firebase token login, sessions, credit balance |
| Project | 8002 | Project CRUD and starring |
| File | 8003 | File/folder storage and project file tree |
| AI | 8004 | Streaming coding agent |
| Terminal | 8005 | Pseudo-terminal sessions per project |
| Payment | 8006 | Razorpay orders; credits granted on verified payment |

## Getting Started

### Prerequisites

- Node.js 20+ and npm
- Docker (for Redis) or a local Redis instance
- A MongoDB database (local or Atlas)
- A Firebase project with a service-account key
- A Razorpay account (test keys are fine)
- An OpenRouter API key

### 1. Install dependencies

Each service has its own `package.json`:

```bash
cd backend
npm install                       # shared deps (ioredis)
for d in gateway services/*; do (cd "$d" && npm install); done
```

### 2. Start Redis

```bash
docker compose up -d redis        # exposes localhost:6379
```

### 3. Configure environment

Create a `.env` in each service folder (see [Environment Variables](#environment-variables)), and place your Firebase service-account JSON at `services/auth/serviceAccountKey.json`.

### 4. Run the services

Start each in its own terminal:

```bash
cd gateway && npm run dev
cd services/auth && npm run dev
cd services/project && npm run dev
cd services/file && npm run dev
cd services/ai && npm run dev
cd services/terminal && npm run dev
cd services/payment && npm run dev
```

The gateway is then available at `http://localhost:8000`. Use `npm start` instead of `npm run dev` for production.

## Environment Variables

Names below are the ones the code reads. Values are examples.

| Service | Variable | Description |
| --- | --- | --- |
| All | `PORT` | Port override (defaults in the table above) |
| All except gateway | `MONGODB_URI` | MongoDB connection string |
| Gateway, Auth, Project | `REDIS_URL` | e.g. `redis://localhost:6379` |
| Gateway | `FRONTEND_URL` | Allowed CORS origin (credentials enabled) |
| Gateway | `AUTH_SERVICE`, `PROJECT_SERVICE`, `FILE_SERVICE`, `AI_SERVICE`, `TERMINAL_SERVICE`, `PAYMENT_SERVICE` | Upstream base URLs (default to `http://localhost:800x`) |
| Auth | `NODE_ENV` | `production` enables `secure` / `SameSite=None` cookies |
| AI | `FILE_SERVICE_URL` | File service base URL |
| AI | `AUTH_SERVICE` | Auth service base URL (credit deduction) |
| AI | `OPENROUTER_API_KEY` | OpenRouter key used by `@langchain/openrouter` |
| Terminal | `FILE_SERVICE_URL` | File service base URL (project sync) |
| Payment | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay credentials |
| Payment | `AUTH_SERVICE` | Auth service base URL (credit top-up) |

> **Never commit secrets.** `.env` and `serviceAccountKey.json` are already in `.gitignore`.

## API Reference

All routes below go through the gateway (`http://localhost:8000`). Except `/api/auth/*`, they require the `session` cookie set at login.

### Auth — `/api/auth`

| Method | Path | Description |
| --- | --- | --- |
| POST | `/login` | Body `{ token }` (Firebase ID token). Creates the user if new (100 free credits), sets the `session` cookie |
| GET | `/logout` | Destroys the session |
| GET | `/api/me` | Current user from the session (gateway route) |

### Projects — `/api/project`

| Method | Path | Description |
| --- | --- | --- |
| POST | `/` | Create project `{ name, description }` |
| GET | `/` | List the user's projects |
| GET | `/starred` | List starred projects |
| GET | `/:id` | Get a project (updates `lastOpenedAt`) |
| PATCH | `/:id` | Toggle starred |
| DELETE | `/:id` | Delete project |

### Files — `/api/file`

| Method | Path | Description |
| --- | --- | --- |
| POST | `/create-root-folder` | `{ projectId, projectName }` |
| POST | `/create-folder` | `{ projectId, parentId, name }` |
| POST | `/create-file` | `{ projectId, parentId, name, content?, language? }` |
| POST | `/update/:id` | `{ name?, content? }` |
| GET | `/:id` | Get a file |
| GET | `/tree/:projectId` | Nested tree for a project |
| DELETE | `/:id` | Soft-delete |

### AI — `/api/ai`

`POST /chat` with `{ projectId, message, history? }` (last 6 history messages used). The response is a **Server-Sent Events** stream:

| Event | Meaning |
| --- | --- |
| `start` | Stream opened |
| `tool_start` | Agent is calling a tool (`{ tool, args }`) |
| `message` | Assistant text |
| `folder_created`, `file_created`, `file_updated`, `file_deleted` | Result of a file operation, so the UI can update live |
| `done` | Finished |
| `error` | Failure after the stream started |

The agent's tools are `get_tree`, `get_file`, `create_folder`, `create_file`, `update_file` and `delete_file`. Each chat request costs **10 credits**.

### Terminal — WebSocket (`/socket.io`)

| Client event | Payload |
| --- | --- |
| `terminal:init` | `{ projectId, userId, cols, rows }` — syncs the project's files to a temp workspace and opens a shell |
| `terminal:write` | Raw input string |
| `terminal:resize` | `{ cols, rows }` |

Server events: `terminal:ready`, `terminal:data`. A `GET /health` endpoint is exposed on the terminal service.

### Payments — `/api/payment`

| Method | Path | Description |
| --- | --- | --- |
| POST | `/create` | `{ plan }` — creates a Razorpay order. Plans: `pro` (₹299, 500 credits), `team` (₹799, 2000 credits) |
| POST | `/verify` | `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` — verifies the HMAC signature and adds credits |

### Internal (not routed by the gateway)

Auth service: `POST /user/deduct-credits` and `POST /user/add-credits`, called by the AI and Payment services.

## Data Models

- **User** — `firebaseUid`, `name`, `email`, `avatar`, `credits` (default 100)
- **Project** — `owner`, `name`, `description`, `starred`, `lastOpenedAt`
- **File** — `owner`, `projectId`, `parentId`, `name`, `type` (`file`/`folder`), `language`, `extension`, `content`, `size`, `isDeleted`
- **Payment** — `userId`, `plan`, `amount`, `credits`, `currency`, `razorpayOrderId`, `razorpayPaymentId`, `status` (`created`/`paid`/`failed`)

## Docker

Each service has a Dockerfile written to be **built from the `backend/` directory** (so `shared/` is available):

```bash
cd backend
docker build -f gateway/Dockerfile -t ai-editor-gateway .
docker build -f services/terminal/Dockerfile -t ai-editor-terminal .
```