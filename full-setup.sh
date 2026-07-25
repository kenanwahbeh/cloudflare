#!/bin/bash

set -e

CF_API="https://api.cloudflare.com/client/v4"

if [ -f .env ]; then
    source .env
fi

api_call() {
    local method=$1
    local endpoint=$2
    local data=$3
    
    if [ -n "$data" ]; then
        curl -s -X "$method" \
            -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            -H "Content-Type: application/json" \
            "$CF_API$endpoint" \
            -d "$data"
    else
        curl -s -X "$method" \
            -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            "$CF_API$endpoint"
    fi
}

echo "========================================="
echo "   Full Setup - All Zones"
echo "========================================="
echo ""

# Verify Token
echo "[1/4] Verifying Token..."
response=$(api_call GET "/user/tokens/verify")
if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
    echo "✓ Token valid"
    echo "$response" | jq -r '.result.permissions | keys[]' | head -10
else
    echo "✗ Invalid token"
    exit 1
fi

# Get Account
echo ""
echo "[2/4] Fetching Account..."
response=$(api_call GET "/accounts")
CLOUDFLARE_ACCOUNT_ID=$(echo "$response" | jq -r '.result[0].id')
ACCOUNT_NAME=$(echo "$response" | jq -r '.result[0].name')
echo "✓ Account: $ACCOUNT_NAME ($CLOUDFLARE_ACCOUNT_ID)"

# Get All Zones
echo ""
echo "[3/4] Fetching All Zones..."
response=$(api_call GET "/zones?per_page=50")
zones=$(echo "$response" | jq -r '.result[] | "\(.id)|\(.name)"')
zone_count=$(echo "$zones" | wc -l)
echo "✓ Found $zone_count zones"

# Save to .env
echo "$zones" > /tmp/zones.txt
cat > .env << EOF
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID
EOF
chmod 600 .env

# Process each zone
echo ""
echo "[4/4] Setting up zones..."
echo ""

while IFS='|' read -r zone_id zone_name; do
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Zone: $zone_name"
    echo "ID: $zone_id"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # DNS Records
    response=$(api_call GET "/zones/$zone_id/dns_records?per_page=100")
    dns_count=$(echo "$response" | jq '.result | length')
    echo "  DNS Records: $dns_count"
    
    # Tunnels
    response=$(api_call GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel")
    tunnel_count=$(echo "$response" | jq '.result | length')
    echo "  Tunnels: $tunnel_count"
    
    # Access Policies
    response=$(api_call GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/policies")
    policy_count=$(echo "$response" | jq '.result | length')
    echo "  Access Policies: $policy_count"
    
    echo ""
done < /tmp/zones.txt

rm -f /tmp/zones.txt

echo "========================================="
echo "   Setup Complete!"
echo "========================================="
echo ""
echo "Account: $ACCOUNT_NAME"
echo "Account ID: $CLOUDFLARE_ACCOUNT_ID"
echo ""
echo "Zones configured:"
echo "$zones" | nl
echo ""
echo "Run MCP server: npx -y @thelord/mcp-cloudflare"
