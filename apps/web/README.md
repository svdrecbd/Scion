# Cell Anatomy web

The public Cell Anatomy site is a Next.js application packaged for Cloudflare Workers with
vinext. Its scientific corpus is a small, versioned metadata snapshot bundled with the Worker;
the deployed site does not require the FastAPI service, Postgres, a VM, raw imaging data, CAOS,
or an account system.

## Public responsibilities

- search and filter 118 literature-derived dataset metadata records
- render corpus analytics, comparisons, dataset details, and experiment-planning guidance
- export filtered corpus metadata as CSV, JSON, or BibTeX
- collect optional beta-interest submissions in Cloudflare D1
- retain the existing feedback `mailto:` link

The removed Data/Pilot viewer and its restricted imaging assets are not part of this build.

## Cloudflare-local development

```bash
npm install
npm run d1:migrate:local
npm run dev:vinext
```

The vinext development server listens on `http://127.0.0.1:3001`. To exercise the exact built
Worker shape instead:

```bash
npm run build:vinext
npm run start:vinext -- --port 8787
```

The ordinary Next.js commands remain useful for framework compatibility checks:

```bash
npm run dev
npm run build
```

The signup endpoint requires a Cloudflare D1 binding at request time, so use a vinext command
when testing form submission.

## Corpus snapshot

[`lib/corpus-data.json`](./lib/corpus-data.json) contains public bibliographic and technical
metadata only. It contains no volume, slice, label, or other imaging payloads. To intentionally
refresh it from a running local API:

```bash
npm run corpus:export-edge
```

The exporter whitelists the 30 `DatasetRecord` fields and rejects empty or duplicate-ID exports.
Review and commit the generated diff so production is reproducible and does not depend on a live
database.

## Beta-interest submissions

D1 migrations live in [`migrations`](./migrations). Email addresses are normalized and unique;
repeat submissions are idempotent. The endpoint also bounds request size, validates field lengths,
and retains the existing honeypot. No email is sent by the site.

Export the local D1 data back to the prior CSV shape:

```bash
npm run signups:export -- --output=beta-signups.csv
```

After a remote D1 database exists, export it with:

```bash
npm run signups:export -- --remote --output=beta-signups.csv
```

The export file is created with owner-only permissions and spreadsheet-formula prefixes are
escaped.

## Remote staging and cutover

The Cloudflare account now has a migrated `cell-anatomy-site` D1 database and the staging Worker
is live at <https://scion-web.svdrecbd.workers.dev>. Redeploy a reviewed revision with:

```bash
npm run build:vinext
npm run deploy:vinext
```

The remaining one-time cutover is intentionally separate: attach `cellanatomy.org` as the Worker
custom domain, verify HTTPS and the production smoke checks, then retire the VM. The current
deployment does not change the domain or the existing VM.
