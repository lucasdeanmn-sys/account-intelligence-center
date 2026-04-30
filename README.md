# Account Intelligence Center

A personal sales intelligence tool for B2B SaaS account executives, built with Next.js 14, Tailwind CSS, and the Anthropic API with MCP server integrations.

## Features

- **Dashboard / Daily Priorities** — AI-ranked deal priority list with reasoning, cross-referenced against Gmail and Calendar activity
- **Account Deep-Dive** — Comprehensive AI-generated briefing pulling from HubSpot, Gmail, Calendar, and web search
- **MSI Renewal Tracker** — Automated analysis of Adtran channel (MSI) deal renewals with CSSA circuit count comparison
- **Push to HubSpot** — Draft and preview notes/tasks before posting to HubSpot

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill in the values:

```bash
cp .env.example .env.local
```

#### Required Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (console.anthropic.com) |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot Private App token with CRM read/write scopes |
| `GOOGLE_OAUTH_TOKEN` | Google OAuth Bearer token (Gmail + Calendar read scopes) |
| `CSSA_API_KEY` | CSSA MCP server API key |

#### HubSpot Token Scopes Needed
- `crm.objects.deals.read`
- `crm.objects.contacts.read`
- `crm.objects.companies.read`
- `crm.objects.notes.read` / `write`
- `crm.objects.tasks.read` / `write`

#### Google OAuth Scopes Needed
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/calendar.readonly`

### 3. Run development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deployment (Vercel)

1. Push to GitHub
2. Import repo in Vercel dashboard
3. Add environment variables in Vercel project settings
4. Deploy

## Architecture

All MCP server calls happen server-side via Next.js API routes — never exposed to the client. The Anthropic API uses the `mcp-client-2025-04-04` beta, which connects Claude to remote MCP servers and handles tool execution internally.

## MSI Deal Logic

MSI deals are identified by `(MSI` in the deal name (e.g., "Acme Corp (MSI - Year 2)").

**M1 Note Format** (stored in HubSpot as HTML):
```html
<i>50 ($12,000) - Jan 2024</i>
<i>50 ($13,200) - Jan 2025</i>
75 ($14,520) - Jan 2026
```
- Number before parenthesis = circuit count for that year
- Parenthetical = contract value
- `<i>` wrapped lines = already invoiced
- First non-italic line = next renewal

**Circuit Discrepancy Logic**: If CSSA actual circuits ≠ contracted circuits, recommend invoicing at actual rounded up to next 50.

## HubSpot Owner ID

All records created by this app use owner ID `32225666`.
