---
name: create-architecture-diagram
description: Use this skill when asked to create an architecture diagram, document system design, or visualise how components connect. Generates Mermaid diagrams embedded in Markdown.
---

## When to Use
Use when the user asks to:
- "create an architecture diagram"
- "draw the system architecture"
- "visualise how this fits together"
- "diagram the infrastructure"
- "create a component diagram"

## Process

1. **Understand the system** — read key files, entry points, and infrastructure config
2. **Identify components:**
   - Frontend clients (web, mobile, CLI)
   - API/backend services
   - Databases and storage
   - External services (Azure, AWS, third-party APIs)
   - Background workers / queues
3. **Map connections** — what calls what? Which are sync vs async?
4. **Generate the diagram** using Mermaid

## Mermaid Templates

### Simple web app
```mermaid
graph TD
  Browser[🌐 Browser\nReact/Vite] --> API[⚙️ API Server\nExpress/Node]
  API --> DB[(🗄️ PostgreSQL)]
  API --> Storage[📦 Azure Blob Storage]
  API --> Auth[🔐 JWT Auth]
```

### Microservices
```mermaid
graph TD
  Client --> GW[API Gateway]
  GW --> SvcA[Service A]
  GW --> SvcB[Service B]
  SvcA --> DB_A[(DB A)]
  SvcB --> DB_B[(DB B)]
  SvcA -.->|async| Queue[🔔 Message Queue]
  Queue -.-> Worker[Background Worker]
```

### Azure infrastructure
```mermaid
graph TD
  User --> AFD[Azure Front Door]
  AFD --> AppSvc[App Service\nNode.js API]
  AppSvc --> PG[(Azure PostgreSQL\nFlexible Server)]
  AppSvc --> KV[Key Vault]
  AppSvc --> AOAI[Azure OpenAI]
  AppSvc --> SA[Storage Account]
```

## Placement
- Embed the Mermaid block in `docs/architecture.md`
- Or add it to the relevant section of `README.md`
- Reference it from the README if in a separate file

## Rules
- Use emojis sparingly for quick visual parsing
- Keep labels to 3 words max
- Use `subgraph` to group by layer (Frontend / Backend / Data / External)
- Mark async connections with `-.->` 
- Don't try to show everything — focus on the key data flows
