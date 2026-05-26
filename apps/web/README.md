# Cell Anatomy web

Next.js front end for the Cell Anatomy MVP.

## Responsibilities

- search and filter datasets
- present commonality summaries
- show compare results
- make the corpus feel browsable and intelligible
- manage email-code account sessions and Workbench pairing approval

## Run locally

```bash
npm install
npm run dev
```

The web app proxies `/api/*` to `SCION_API_BASE_URL` or `NEXT_PUBLIC_SCION_API_BASE_URL`, defaulting to `http://127.0.0.1:8000/api`. The account page is at `/account`; in local development login codes are available from the API outbox at `apps/api/.run/auth-codes.log`.
