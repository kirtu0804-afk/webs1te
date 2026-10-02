# Mori Cafe + Kitchen

## Environment

Copy `.env.example` to `.env` only when your host loads environment files. Otherwise configure the variables in the host's environment settings. The production server refuses to start unless `ADMIN_API_TOKEN`, `FRONTEND_ORIGIN`, and an absolute `DATA_DIRECTORY` are set. This application currently does not require API keys, database credentials, or third-party tokens.

Do not use `NEXT_PUBLIC_`, `REACT_APP_`, or `VITE_` prefixes for secrets. Those prefixes expose values to browser code.

## Personal Data Map

| Collection point | Data collected | Storage | External sharing |
| --- | --- | --- | --- |
| Booking form | Name, email, party size, requested date and time | Local `data/mori-records.json`, then the local `mori-requests.xlsx` workbook | None |
| Order form | Name, phone number, fulfillment choice, food items, notes | Local `data/mori-records.json`, then the local `mori-requests.xlsx` workbook | None |
| Privacy deletion form | Request ID and one-time privacy code | Used only to verify and delete a matching local record; not written to the workbook | None |

The app does not collect passwords, payment details, addresses, dates of birth, IP addresses, device identifiers, cookies, browser storage, analytics, or error-tracking data. Express and ExcelJS run locally and no third-party API or SDK receives user data.

`/api/entry-count` returns counts only. Detailed records are never returned to the public client. Operator-only reset and export routes require the server-side `ADMIN_API_TOKEN` header. The request deletion flow removes the matching booking or order after the user supplies the request ID and its one-time privacy code. Older requests created before privacy codes were introduced require operator deletion.

## Secret rotation warning

If a secret was ever hardcoded in a working copy, deployment configuration, or git history, rotate it immediately. Removing it from the current source does not remove it from prior commits or logs. Revoke the old value, create a new one, store it only in the deployment environment, and review repository access.
