# Scion onboarding

This is the fast orientation pass for a new contributor.

## 1. What Scion is

Scion is a searchable dataset atlas for researchers. It is built to move from a raw list of papers into a structured decision-support tool.

The workflow is:
**search → analytics → design → cite**

## 2. Engineering stance

- **Thin Frontend**: Keep the UI server-side as much as possible. No heavy state libraries.
- **Zero-Bloat**: No Docker. Postgres runs natively and that is the only supported local DB path.
- **Native Visualizations**: Custom SVG/CSS charts only. No external charting libraries (D3, etc.) allowed without explicit approval.
- **Transparent Logic**: Scoring and feasibility math must be simple, documented, and backend-driven.

## 3. How to run locally

### Prerequisites
- Python 3.11+
- Node 20+
- Postgres 16 (Native via Homebrew)

### Setup
```bash
# Install and start Postgres
brew install postgresql@16
brew services start postgresql@16

# Project setup
make bootstrap
make db-migrate
make db-seed
```

### Run
```bash
make stack-up
```

### Stack lifecycle
```bash
make stack-status
make stack-down
```

### Run services separately
```bash
make api   # Stable API on port 8000
make web   # Stable web server on port 3000
```

### Development mode
```bash
make api-dev   # Reload-enabled API
make web-dev   # Next.js dev server
```

### Verification
```bash
make check
```

If you are only editing wording, guide copy, or page labels, you usually do not need the full stack immediately. Start by reading the relevant page/component file and make small edits there first.

## 4. Where to start reading

- `README.md` - Core product vision.
- `LABNOTES.md` - Internal history and decision log.
- `apps/api/app/repositories.py` - SQL logic for filtering and similarity.
- `apps/api/app/services/plan.py` - The feasibility engine for experiment planning.
- `apps/web/app/analytics/page.tsx` - Custom SVG visualizations.

If you are doing copy or guidance work, start here instead:

- `apps/web/app/guide/page.tsx` - The user-facing guide.
- `apps/web/app/page.tsx` - Corpus landing page copy and layout.
- `apps/web/app/analytics/page.tsx` - Analytics page framing and explanatory text.
- `apps/web/app/plan/page.tsx` - Planner copy and interpretation language.
- `apps/web/components/navbar.tsx` - Global navigation labels.

For simple wording changes, GitHub web editing is fine. For behavior changes, use a branch and open a PR.

## 5. Team rules

1. **Boxes only**: Use `border-radius: 0px` for all new UI elements.
2. **Typography first**: Use standard EB Garamond weights. No bold headers without reason.
3. **URL is the state**: All filters, selections, and search terms must be reflected in the URL for shareability.
4. **SQL First**: Perform as much data narrowing as possible in Postgres before it reaches Python.
5. **Copy should clarify, not posture**: prefer practical explanation over product language.
