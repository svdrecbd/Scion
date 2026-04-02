# Scion onboarding

This is the fast orientation pass for a new contributor.

## 1. What Scion is

Scion is a searchable dataset atlas for researchers. It is built to move from a raw list of papers into a structured decision-support tool.

The workflow is:
**search → analytics → design → cite**

## 2. Engineering stance

- **Thin Frontend**: Keep the UI server-side as much as possible. No heavy state libraries.
- **Zero-Bloat**: No Docker in the default local path. Postgres runs natively.
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
make api   # Port 8000
make web   # Port 3000
```

## 4. Where to start reading

- `README.md` - Core product vision.
- `LABNOTES.md` - Internal history and decision log.
- `apps/api/app/repositories.py` - SQL logic for filtering and similarity.
- `apps/api/app/services/plan.py` - The feasibility engine for experiment planning.
- `apps/web/app/analytics/page.tsx` - Custom SVG visualizations.

## 5. Team rules

1. **Boxes only**: Use `border-radius: 0px` for all new UI elements.
2. **Typography first**: Use standard EB Garamond weights. No bold headers without reason.
3. **URL is the state**: All filters, selections, and search terms must be reflected in the URL for shareability.
4. **SQL First**: Perform as much data narrowing as possible in Postgres before it reaches Python.
