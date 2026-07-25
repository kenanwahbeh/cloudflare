# AGENTS.md - Cloudflare API Setup Scripts

## Purpose
Bash scripts for managing Cloudflare account via API. Uses API Token (Bearer auth) with `curl` + `jq`.

## Key Facts
- **API Token**: Stored in `.env` as `CLOUDFLARE_API_TOKEN` (NOT API Key)
- **Account ID**: `50d79fcbc90bf84876653d770bc1c0ec` (kinan)
- **Auth header**: `Authorization: Bearer $CLOUDFLARE_API_TOKEN`
- **API base**: `https://api.cloudflare.com/client/v4`

## Scripts
| Script | Purpose |
|--------|---------|
| `setup-cloudflare.sh` | Interactive setup wizard (token → account → zone → .env) |
| `auto-setup.sh` | Full auto-setup including tunnel + access policy |
| `full-setup.sh` | Non-interactive setup for all zones |
| `multi-zone-setup.sh` | Multi-zone setup with zone enumeration |

## Running Scripts
```bash
# All scripts require interactive input
./setup-cloudflare.sh      # Guided setup
./auto-setup.sh             # Full auto-setup
./full-setup.sh             # Requires .env pre-configured
./multi-zone-setup.sh       # Multi-zone setup
```

## Dependencies
- `curl` (required)
- `jq` (auto-installed if missing)

## Conventions
- Scripts use `set -e` (exit on error)
- Output uses ANSI color codes (RED, GREEN, YELLOW, BLUE, CYAN, NC)
- `.env` file is created with `chmod 600` (secure permissions)
- API responses are parsed with `jq`

## Free Plan Limitations
- WAF deprecated → use Managed Rulesets instead
- Minify does not work on free plan
- D1 databases can be created but have storage limits

## API Gotchas
- Zone delete requires Global API Key (not API Token)
- Access session_duration: 24h max on free plan
- Catch-all email rules cannot be modified via API (Dashboard only)
- DNSSEC pending status needs nameserver propagation time
