# Scion Handoff

Last updated: 2026-05-15

## Purpose

This file is the current handoff note for Scion. It is meant to let a new contributor or a future session pick up the project without re-discovering the current state, the deployment quirks, or the product decision boundary.

## Current Snapshot

- Canonical repo working copy: `/Users/svdr/Downloads/scion-skeleton`
- Public site: [https://cellanatomy.org](https://cellanatomy.org)
- Production VM: `temp` in GCP (`us-west1-a`)
- Domain DNS: Squarespace
- TLS / reverse proxy: Caddy on the VM
- Web app: Next.js 15
- API: FastAPI
- Local DB path: native Postgres only

## Current Git State

- Branch: `main`
- Last pushed commit on `origin/main`: `1e4d520` (`Refine about page balance and lab naming`)
- Live site includes everything through `1e4d520`
- There is an unpushed local patch on top of `main`
- The local patch now includes the earlier Bucket 2 safe pass plus a lightweight beta-interest capture flow

### Unpushed files

- `apps/api/app/routes/datasets.py`
- `apps/api/app/routes/signups.py` (new file)
- `apps/api/app/config.py`
- `apps/api/app/main.py`
- `apps/api/app/schemas.py`
- `apps/api/tests/test_datasets_integration.py`
- `apps/api/tests/test_health.py`
- `apps/web/app/api/beta-signups/route.ts` (new file)
- `apps/web/app/compare/page.tsx`
- `apps/web/app/datasets/[id]/page.tsx`
- `apps/web/app/globals.css`
- `apps/web/app/layout.tsx`
- `apps/web/app/plan/page.tsx`
- `apps/web/components/beta-signup-prompt.tsx` (new file)
- `apps/web/components/citation-button.tsx`
- `apps/web/components/compare-summary.tsx`
- `apps/web/components/dataset-card.tsx`
- `apps/web/components/copy-text-button.tsx` (new file)
- `handme.md` (new file)

## What Is Already Shipped

### Bucket 1 / public-language hardening

Already pushed and deployed:

- homepage / guide / about copy cleanup
- clearer public-data and voxel-size wording
- provenance wording tightened across user-facing surfaces
- about page rebalanced
- `Laboratory of Cell Geometry` naming fix
- pilot nav visibility stabilized
- pilot lineup cards framed
- pilot viewer scale overlay cleanup

### Public site and SSL

Already working in production:

- `https://cellanatomy.org`
- `https://www.cellanatomy.org` redirects to apex
- Caddy terminates TLS and proxies:
  - normal site traffic -> `127.0.0.1:3000`
  - `/api/*` -> `127.0.0.1:8000`

## What Exists Locally But Is Not Yet Pushed

This is the current Bucket 2 safe pass. It was intentionally limited to work that does not force a product decision.

### Plan

- visible precedent table, PMID list, and CSV export are now aligned to the same filter/sort state
- added `precedent_public` filter
- added `author_asc` sort
- added `Copy PMID List`
- export button now says `Download Visible CSV`
- wording now explicitly says the table shows `record-level precedents`

### Compare

- stronger warning when multiple selected records come from the same paper
- clearer dataset-vs-study caveat language
- compare citation lines now link out to paper URLs when available
- compare headers now show PMIDs inline

### Dataset surfaces

- dataset cards now include PMID in visible citation lines
- dataset detail header now includes PMID
- similar-record cards on detail pages now include better provenance
- `Captured Organelle Pairs` was renamed to `Derived Organelle Pairs`
- detail view now explicitly says organelle pairs are metadata-derived and not proof of measured contact sites

### Citation handling

- copied citation text now uses a unified study label
- copied citation text includes PMID and source publication URL when available

### API support

- plan export route now accepts and honors:
  - `precedent_query`
  - `precedent_public`
  - `precedent_sort`
- plan export now returns the same filtered/sorted visible records instead of the full unfiltered precedent set
- regression coverage added for filtered/sorted plan export

## Additional Local Work: Beta Interest Capture

Added after the Bucket 2 safe pass on 2026-05-15:

- global delayed beta-interest prompt mounted in the web layout
- silent 90-second delay by default
- `localStorage` persistence so a browser that closes or submits the prompt is not asked again
- fields are ordered:
  - First name
  - Last name
  - Affiliation
  - Email
- only email is required
- dismissal uses only the top-right `X`; there is no secondary `Not now` button
- submission posts to `/api/beta-signups`
- local Next route proxies to FastAPI for local dev when Caddy is not in front
- FastAPI appends to a private CSV path
- default CSV path is `.run/beta-signups.csv`
- production can override with `SCION_BETA_SIGNUP_CSV_PATH`
- CSV rows include:
  - created timestamp
  - email
  - first name
  - last name
  - affiliation
  - source path
  - consent text version
- endpoint includes email validation, a hidden honeypot field, simple per-client rate limiting, and CSV-injection escaping

Suggested production CSV path:

```bash
SCION_BETA_SIGNUP_CSV_PATH=/var/lib/scion/beta-signups.csv
```

If manually emailing early users, use BCC and honor removal requests manually.

## Additional Local Work: Public Brand Pass

Added after the beta-interest prompt work on 2026-05-15:

- Public site branding should now use `Cell Anatomy`, not `Scion`.
- Public product language should be contextual, not a one-for-one replacement:
  - `Cell Anatomy` for the parent/public brand
  - `Cell Anatomy Corpus` for the searchable/indexed atlas
  - `the corpus`, `the atlas`, or `this interface` in body copy when repeating the brand would read clunky
  - `Indexed in the Cell Anatomy Corpus` for citation/export provenance
- Footer legal line is now generated with the current year:
  - `© {currentYear} General Cell Anatomy Group - Ad Interiora.`
- The public-facing Next app pages/components were scrubbed of rendered `Scion` copy.
- The API title/root message and user-facing error/export text were updated where appropriate.
- Internal identifiers were intentionally left alone for now:
  - `SCION_*` env vars
  - `scion-*` package/db/logger/localStorage names
  - `ScionApiError` class name
  - `/opt/scion` deployment paths
  - repo and local data directory names
- Do not blindly replace internal identifiers unless doing a dedicated infrastructure rename.

## Additional Local Work: Beta Prompt Image Band

Added after the public brand pass on 2026-05-15:

- The beta-interest modal now includes a restrained top texture band.
- Asset path:
  - `apps/web/public/brand/lake-michigan-ice-band.jpg`
- The asset is a small optimized crop from the Lake Michigan January photo supplied by Salvador.
- The original full-size photo was intentionally not committed into the app.
- This image is only used in the signup modal for now; do not apply it across the site until a broader brand direction is approved.

## Verification Status

Last verified locally on 2026-05-12:

- `cd apps/web && npm run typecheck` -> passed
- `cd apps/web && npm run build` -> passed
- `apps/api/.venv/bin/pytest apps/api/tests/test_datasets_integration.py -q` -> `6 passed`

Additional verification on 2026-05-15:

- `git diff --check` -> passed
- `apps/api/.venv/bin/pytest apps/api/tests/test_health.py -q` -> `11 passed`
- `cd apps/web && npm run typecheck` -> passed
- `cd apps/web && npm run build` -> passed
- browser verification with prompt delay forced to `0` -> prompt rendered, submission succeeded, CSV row written through the web proxy and FastAPI

## Current Product-Decision Boundary

The safe no-decision cleanup is effectively done. The remaining meaningful work now crosses into product semantics.

### Safe work completed or in progress

- provenance consistency
- plan table / export / PMID polish
- same-study warnings in compare
- inferred-biology wording cleanup

### Remaining work that requires explicit product decisions

1. **Dataset-first vs study-first**
   - Current operational model is dataset/record-first.
   - UI has been hardened to say this explicitly.
   - Do not silently convert the app to study-first.

2. **Comparability / metadata score treatment**
   - Decide whether these stay numeric, become banded, or get visually demoted.

3. **Inferred vs explicit biology**
   - Scion should not overclaim measured biology from metadata-derived structure.
   - `Derived Organelle Pairs` is the current safe wording.
   - A broader policy decision is still pending.

4. **Source-faithful terminology vs normalized ontology**
   - Terms like `conoid`, `rhoptry`, `axoneme`, `mvb`, etc. currently remain source-faithful.
   - A future decision may add a second normalized layer, but that has not been approved.

## User / Product Conditions Already Established

These are the practical constraints already set up during this project and should be treated as active unless explicitly changed.

### Product / scope conditions

- Product decisions were intentionally deferred until the safe work was exhausted.
- There is currently no demo deadline driving rushed decisions.
- Do not smuggle in semantics changes as “UI cleanup.”
- Keep the current model record-first unless the product decision is made explicitly.
- Avoid overclaiming scientific meaning from derived metadata.

### UI / design conditions

- sharp-edged boxes only; `border-radius: 0`
- typography matters more than decorative UI
- EB Garamond is the default reading/copy face
- bold/display text should generally read as intentional display typography rather than body-copy bolding
- cards are the preferred default surface where applicable
- copy should clarify; it should not posture

### Engineering conditions

- native Postgres only for local development
- no Docker workflow
- thin frontend, backend-driven semantics
- URL is canonical state
- no silent failures

## Local Development

### First-time setup

```bash
brew install postgresql@16
brew services start postgresql@16

make bootstrap
make db-migrate
make db-seed
```

### Managed local stack

```bash
make stack-up
make stack-status
make stack-down
```

Local endpoints:

- Web: `http://localhost:3000`
- API: `http://localhost:8000`
- API docs: `http://localhost:8000/docs`

### Separate service runs

```bash
make api
make web
```

### Dev mode

```bash
make api-dev
make web-dev
```

### Full check

```bash
make check
```

## Deployment Notes

### Important rule

Do **not** run deploy commands in Google Cloud Shell and assume that updates the VM. Cloud Shell is not the server.

- Cloud Shell = jump point / control plane
- VM `temp` = actual Scion host

### Correct production deploy flow

SSH into the VM first:

```bash
gcloud compute ssh temp --zone=us-west1-a
```

Then on the VM:

```bash
cd /opt/scion
git fetch origin main
git reset --hard origin/main

cd apps/web
npm ci
npm run build

cd /opt/scion
sudo systemctl restart scion-web
```

Verification:

```bash
curl -I http://127.0.0.1:3000
curl -I https://cellanatomy.org
sudo systemctl status scion-web --no-pager -l
```

### Common production gotcha

Immediately after restarting `scion-web`, Caddy can briefly return `502` before Next is ready. This is usually just a restart race.

Standard fix:

```bash
sleep 5
curl -I http://127.0.0.1:3000
curl -I https://cellanatomy.org
```

If localhost is healthy and public still fails, reload Caddy:

```bash
sudo systemctl reload caddy
```

## Production DNS / TLS / Routing

### DNS

Managed in Squarespace:

- `A @ -> 34.187.255.203`
- `CNAME www -> cellanatomy.org`

### TLS / proxy

Handled by Caddy on the VM.

- Public domain: `cellanatomy.org`
- `www.cellanatomy.org` redirects to apex
- HTTP is redirected to HTTPS
- Caddy proxies:
  - `/api/*` -> FastAPI on `127.0.0.1:8000`
  - all other traffic -> Next on `127.0.0.1:3000`

### Do not break this

- do not delete `/var/lib/caddy`
- do not close inbound `80/tcp` or `443/tcp`
- do not replace the domain-based Caddy config with an IP-only block
- do not assume Cloud Shell changes affect the VM

## Public Data Pilot

### Current status

The pilot exists and is live-capable behind env flags. It includes:

- dataset lineup page
- per-pilot dataset pages
- slice viewer
- pilot asset serving
- pilot status endpoint

### Important env flags

Runtime toggle:

```bash
SCION_ENABLE_PUBLIC_DATA_PILOT=true
SCION_PUBLIC_DATA_ROOT=/opt/scion-public-data
```

Behavior:

- in development, pilot routes are visible by default
- in production, pilot visibility depends on `SCION_ENABLE_PUBLIC_DATA_PILOT=true`
- `SCION_PUBLIC_DATA_ROOT` controls where mirrored pilot data lives

### Pilot commands

```bash
make pilot-index PUBLIC_DATA_ROOT="$HOME/Downloads/scion-public-data"
make pilot-convert PILOT_SLUG=<slug> PUBLIC_DATA_ROOT="$HOME/Downloads/scion-public-data"
make pilot-slices PILOT_SLUG=<slug> PUBLIC_DATA_ROOT="$HOME/Downloads/scion-public-data"
```

### Current pilot direction

- native low-bloat Scion slice viewer first
- Neuroglancer later as a power-user path
- OME-Zarr remains the eventual streamable target

## Known Operational Gotchas

1. **Cloud Shell confusion**
   - Running `cd /opt/scion` in Cloud Shell will fail because that path exists on the VM, not in Cloud Shell.

2. **Next server action warnings in logs**
   - Old log lines like `Failed to find Server Action "x"` are usually stale client requests from an older deployment, not a current outage.

3. **Firefox / local browser TLS weirdness**
   - If one machine shows `PR_CONNECT_RESET_ERROR` but the site works elsewhere, assume local browser/VPN/DNS/security-software trouble before touching production.

4. **Typecheck vs build**
   - `npm run typecheck` can depend on generated Next types existing. If it fails strangely, run `npm run build` and try again.

## Recommended Next Actions

### If the goal is to ship the current safe pass

1. review local Bucket 2 changes on:
   - `/plan`
   - `/compare`
   - a few dataset detail pages
2. review the beta-interest prompt once with `NEXT_PUBLIC_SCION_BETA_PROMPT_DELAY_MS=0`
3. decide the production CSV path and set `SCION_BETA_SIGNUP_CSV_PATH`
4. commit and push the local patch
5. deploy to the VM

### If the goal is to move into product work

Discuss these in this order:

1. keep record-first only, or add study-level presentation
2. keep numeric scores, band them, or demote them
3. define the policy line between inferred biology and explicit claims
4. decide whether source-faithful biology terms need a normalized companion layer

## Suggested Commit Boundary For The Current Local Patch

The current local patch is a coherent commit. It can be described roughly as:

- plan precedent table/export/PMID alignment
- compare same-study warnings and citation hardening
- dataset provenance consistency
- derived organelle-pair wording cleanup
- lightweight beta-interest capture with private CSV persistence

## Handoff Summary

If you are picking this up cold:

- production is healthy
- SSL and DNS are already working
- the repo has one meaningful unpushed patch: Bucket 2 safe pass plus beta-interest capture
- the next real work is either shipping that patch or making product decisions
- do not waste time re-litigating Docker, study-vs-record silently, or Cloud Shell deployment mistakes
