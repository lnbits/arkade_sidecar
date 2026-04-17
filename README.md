# Arkade Sidecar

This sidecar exposes an HTTP API for LNbits to use Arkade for lightning payments. 

Docs:

- https://docs.arkadeos.com/
- https://docs.arkadeos.com/llms.txt

## Install

```bash
npm install
```

## Run

```bash
ARKADE_MNEMONIC="bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom" \
ARKADE_ARK_SERVER_URL="https://arkade.computer" \
ARKADE_BOLTZ_SERVER_URL="https://api.ark.boltz.exchange" \
ARKADE_SIDECAR_PORT=8765 \
node server.mjs
```

Optional API key:

```bash
ARKADE_SIDECAR_API_KEY="mykey"
```

Set the same key in LNbits as `ARKADE_L2_API_KEY`.

If you prefer to provide the mnemonic after startup, omit `ARKADE_MNEMONIC` and
POST it to the sidecar:

```bash
curl -X POST http://127.0.0.1:8765/v1/mnemonic \
  -H "Content-Type: application/json" \
  -d '{"mnemonic":"bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom"}'
```

## Endpoints

- `POST /v1/mnemonic`
- `POST /v1/balance`
- `POST /v1/invoices`
- `POST /v1/payments`
- `GET /v1/invoices/stream`
- `GET /v1/invoices/{id}`
- `GET /v1/payments/{id}`
- `GET /health`

## Environment variables

| Variable                           | Default                          | Description                               |
| ---------------------------------- | -------------------------------- | ----------------------------------------- |
| `ARKADE_MNEMONIC`                  | —                                | 12-word BIP39 mnemonic                    |
| `ARKADE_IS_MAINNET`                | auto                             | Set to `false` for non-mainnet wallets    |
| `ARKADE_NETWORK`                   | `mainnet`                        | Optional network hint for Boltz selection |
| `ARKADE_ARK_SERVER_URL`            | `https://arkade.computer`        | Arkade operator URL                       |
| `ARKADE_BOLTZ_SERVER_URL`          | `https://api.ark.boltz.exchange` | Boltz API URL                             |
| `ARKADE_BOLTZ_NETWORK`             | derived                          | Override Boltz network name               |
| `ARKADE_SIDECAR_HOST`              | `127.0.0.1`                      | Listen host                               |
| `ARKADE_SIDECAR_PORT`              | `8765`                           | Listen port                               |
| `ARKADE_SIDECAR_API_KEY`           | —                                | Optional `x-api-key` header value         |
| `ARKADE_SIDECAR_STATE_PATH`        | `./arkade-sidecar-state.json`    | Persisted payment/invoice state           |
| `ARKADE_STORAGE_PATH`              | `./arkade-wallet.sqlite`         | Wallet SQLite database path               |
| `ARKADE_SWAP_STORAGE_PATH`         | `./arkade-swaps.sqlite`          | Swap repository storage path              |
| `ARKADE_PAY_TIMEOUT_MS`            | `30000`                          | Timeout for synchronous Lightning sends   |
| `ARKADE_STREAM_KEEPALIVE_MS`       | `15000`                          | SSE keepalive comment interval            |
| `ARKADE_STREAM_HEARTBEAT_MS`       | `30000`                          | SSE heartbeat interval                    |
| `ARKADE_STATE_PERSIST_DEBOUNCE_MS` | `1000`                           | State persistence debounce                |
| `ARKADE_CORS_ALLOW_ORIGIN`         | —                                | Optional allowed browser origin           |
| `ARKADE_CORS_ALLOW_HEADERS`        | `Content-Type, x-api-key`        | Allowed CORS request headers              |
| `ARKADE_CORS_ALLOW_METHODS`        | `GET, POST, OPTIONS`             | Allowed CORS methods                      |

## Notes

- The HTTP API mirrors the Spark sidecar shape so LNbits can use the same
  balance, invoice, payment, and stream flows.
- Lightning receive invoices are monitored in the background and emitted on the
  SSE stream once claimed into the Arkade wallet.
- Payment and invoice lookup endpoints are backed by local persisted state so
  LNbits can poll by `checking_id`.
