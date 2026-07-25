# AGENTS.md - Cloudflare API

## Key Facts
- **API Token**: Stored in `.env` as `CLOUDFLARE_API_TOKEN` (NOT API Key)
- **Account ID**: `50d79fcbc90bf84876653d770bc1c0ec` (kinan) — use directly in API paths
- **Auth header**: `Authorization: Bearer $CLOUDFLARE_API_TOKEN`
- **API base**: `https://api.cloudflare.com/client/v4`

## Free Plan Limitations
- WAF deprecated → use Managed Rulesets instead
- Minify does not work on free plan
- D1 databases can be created but have storage limits

## API Gotchas
- Zone delete requires Global API Key (not API Token)
- Access session_duration: 24h max on free plan
- Catch-all email rules cannot be modified via API (Dashboard only)
- DNSSEC pending status needs nameserver propagation time
