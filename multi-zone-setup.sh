#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

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

ask_approval() {
    local msg=$1
    echo -e "${YELLOW}$msg${NC}"
    read -p "Approve? (y/n): " choice
    [[ "$choice" =~ ^[Yy]$ ]]
}

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Cloudflare Multi-Zone Setup        ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

# Verify Token
echo -e "${CYAN}Verifying Token...${NC}"
response=$(api_call GET "/user/tokens/verify")
if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Token valid${NC}"
else
    echo -e "${RED}✗ Invalid token${NC}"
    exit 1
fi

# Get Account
echo -e "${CYAN}Fetching Account...${NC}"
response=$(api_call GET "/accounts")
CLOUDFLARE_ACCOUNT_ID=$(echo "$response" | jq -r '.result[0].id')
ACCOUNT_NAME=$(echo "$response" | jq -r '.result[0].name')
echo -e "${GREEN}✓ Account: $ACCOUNT_NAME${NC}"

# Get All Zones
echo -e "${CYAN}Fetching Zones...${NC}"
response=$(api_call GET "/zones")
zones=$(echo "$response" | jq -r '.result[] | "\(.id)|\(.name)"')
zone_count=$(echo "$zones" | wc -l)
echo -e "${GREEN}✓ Found $zone_count zones${NC}"
echo ""

# Save all zones to .env
cat > .env << EOF
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID
ALL_ZONES="$zones"
EOF
chmod 600 .env

# Process each zone
current_zone=1
echo "$zones" | while IFS='|' read -r zone_id zone_name; do
    echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Zone $current_zone/$zone_count: $zone_name${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
    echo ""
    
    # DNS Records count
    response=$(api_call GET "/zones/$zone_id/dns_records?per_page=1")
    total_dns=$(echo "$response" | jq -r '.result_info.total_count // 0')
    echo -e "${CYAN}DNS Records: $total_dns${NC}"
    
    # Check existing tunnels
    response=$(api_call GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel")
    tunnel_count=$(echo "$response" | jq '.result | length')
    echo -e "${CYAN}Tunnels: $tunnel_count${NC}"
    
    # Check Access policies
    response=$(api_call GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/policies")
    policy_count=$(echo "$response" | jq '.result | length')
    echo -e "${CYAN}Access Policies: $policy_count${NC}"
    echo ""
    
    current_zone=$((current_zone + 1))
done

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          All Zones Loaded!           ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Account:${NC} $ACCOUNT_NAME"
echo -e "${GREEN}Zones:${NC}"
echo "$zones" | nl
echo ""
echo -e "${YELLOW}Run the MCP server with:${NC}"
echo "npx -y @thelord/mcp-cloudflare"
