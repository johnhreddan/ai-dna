# AI-DNA Version 3

Professional single-screen AI investment intelligence application.

## Structure
- `index.html` application shell
- `assets/css/app.css` interface styling
- `assets/js/app.js` interaction and popup logic
- `data/app-data.js` sectors, companies, relationships and embedded intelligence
- `api/yahoo.js` Vercel serverless Yahoo Finance adapter

## Verified improvements
- Front end uses only `/api/yahoo`; no browser-side Yahoo calls or public CORS proxies.
- Popup requests have a 9-second timeout.
- Opening another company cancels the previous request.
- Stale responses cannot overwrite the active company.
- Successful quotes are cached for five minutes.
- Error state includes a retry control.
- Closing the dialog cancels in-flight work.

Deploy the repository root to Vercel.
